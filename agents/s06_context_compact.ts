#!/usr/bin/env ts-node
// Harness: context durability -- enabling infinite sessions through compression.
// @ts-nocheck
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. JSON SERIALIZATION:
 *    - Python: json.dumps(msg, default=str) for complex objects
 *    - TypeScript: JSON.stringify() with replacer function
 *    - Both need to handle non-serializable objects
 *
 * 2. FILE I/O:
 *    - Python: with open(path, "w") as f: f.write(...)
 *    - TypeScript: await fs.writeFile(path, data) (async)
 *    - TypeScript requires async/await for file operations
 *
 * 3. ARRAY MUTATION:
 *    - Python: Direct mutation of lists and dicts
 *    - TypeScript: Can mutate, but type safety ensures structure
 *    - Both modify messages in place for micro_compact
 *
 * 4. TOKEN ESTIMATION:
 *    - Python: len(str(messages)) // 4
 *    - TypeScript: JSON.stringify(messages).length / 4
 *    - Both use rough estimation (same algorithm)
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";

// Load environment variables
config();

if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

// Configuration
const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

/**
 * Rough token count: ~4 chars per token
 * TypeScript: Returns number
 * Python: def estimate_tokens(messages: list) -> int
 */
function estimateTokens(messages: Message[]): number {
    // TypeScript: JSON.stringify with replacer for complex objects
    // Python: len(str(messages))
    const jsonString = JSON.stringify(messages, (_, value) => {
        if (typeof value === "object" && value !== null) {
            if ("type" in value && "text" in value) {
                return { type: value.type, text: value.text };
            }
        }
        return value;
    });
    return Math.floor(jsonString.length / 4);
}

/**
 * LAYER 1: micro_compact - Replace old tool results with placeholders
 *
 * This runs silently every turn to keep context size manageable.
 * Keeps the last N tool results with full content, replaces older ones
 * with brief placeholders.
 *
 * TypeScript: Returns modified Message array (mutates in place)
 * Python: def micro_compact(messages: list) -> list
 */
function microCompact(messages: Message[]): Message[] {
    // Collect all tool_result entries with their indices
    // TypeScript: Array of tuples
    // Python: tool_results = []
    interface ToolResultEntry {
        msgIdx: number;
        partIdx: number;
        result: ToolResultBlock;
    }

    const toolResults: ToolResultEntry[] = [];

    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        if (msg.role === "user" && Array.isArray(msg.content)) {
            for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
                const part = msg.content[partIdx];
                if (part.type === "tool_result") {
                    toolResults.push({
                        msgIdx,
                        partIdx,
                        result: part as ToolResultBlock,
                    });
                }
            }
        }
    }

    // If we have fewer results than KEEP_RECENT, nothing to do
    if (toolResults.length <= KEEP_RECENT) {
        return messages;
    }

    // Find tool_name for each result by matching tool_use_id in assistant messages
    // TypeScript: Map for O(1) lookups
    // Python: tool_name_map = {}
    const toolNameMap = new Map<string, string>();

    for (const msg of messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === "tool_use" && "id" in block && "name" in block) {
                    toolNameMap.set(block.id as string, block.name as string);
                }
            }
        }
    }

    // Clear old results (keep last KEEP_RECENT)
    // TypeScript: Slice array to get old results
    // Python: to_clear = tool_results[:-KEEP_RECENT]
    const toClear = toolResults.slice(0, -KEEP_RECENT);

    for (const { result } of toClear) {
        if (
            typeof result.content === "string" &&
            result.content.length > 100
        ) {
            const toolId = result.tool_use_id;
            const toolName = toolNameMap.get(toolId) || "unknown";

            // Replace with placeholder
            // TypeScript: Direct property mutation
            // Python: result["content"] = f"[Previous: used {tool_name}]"
            result.content = `[Previous: used ${toolName}]`;
        }
    }

    return messages;
}

/**
 * LAYER 2: auto_compact - Save transcript, summarize, replace messages
 *
 * When context exceeds threshold, save full transcript and ask LLM
 * to summarize. Then replace all messages with the summary.
 *
 * TypeScript: async function returning new Message array
 * Python: def auto_compact(messages: list) -> list
 */
async function autoCompact(messages: Message[]): Promise<Message[]> {
    // Create transcript directory if it doesn't exist
    // TypeScript: await fs.mkdir
    // Python: TRANSCRIPT_DIR.mkdir(exist_ok=True)
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });

    // Save full transcript to disk
    // TypeScript: Timestamp with Date.now()
    // Python: int(time.time())
    const timestamp = Date.now();
    const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

    // Write each message as a JSON line
    // TypeScript: JSON.stringify with replacer
    // Python: json.dumps(msg, default=str)
    const lines = messages.map((msg) =>
        JSON.stringify(msg, (_, value) => {
            // Handle complex objects
            if (typeof value === "object" && value !== null) {
                if ("type" in value) {
                    return value;
                }
            }
            return value;
        })
    );

    await fs.writeFile(transcriptPath, lines.join("\n") + "\n", "utf-8");
    console.log(`[transcript saved: ${transcriptPath}]`);

    // Ask LLM to summarize
    // TypeScript: Limit string with slice
    // Python: conversation_text = json.dumps(messages, default=str)[:80000]
    const conversationText = JSON.stringify(
        messages,
        (_, value) => {
            if (typeof value === "object" && value !== null) {
                if ("type" in value) {
                    return value;
                }
            }
            return value;
        }
    ).slice(0, 80000);

    const summaryResponse = await client.messages.create({
        model: MODEL,
        messages: [
            {
                role: "user",
                content:
                    "Summarize this conversation for continuity. Include: " +
                    "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
                    "Be concise but preserve critical details.\n\n" +
                    conversationText,
            },
        ],
        max_tokens: 2000,
    });

    const summary =
        summaryResponse.content[0].type === "text"
            ? summaryResponse.content[0].text
            : "Summary unavailable";

    // Replace all messages with compressed summary
    // TypeScript: Return new array
    // Python: return [{...}, {...}]
    return [
        {
            role: "user",
            content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
        },
        {
            role: "assistant",
            content: "Understood. I have the context from the summary. Continuing.",
        },
    ];
}

/**
 * Tool implementations (same as s05)
 */
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

const execAsync = promisify(exec);

async function runBash(command: string): Promise<string> {
    const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"] as const;

    if (DANGEROUS.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR,
            timeout: 120000,
        });

        const output = (stdout + stderr).trim();
        return output ? output.slice(0, 50000) : "(no output)";
    } catch (error) {
        if (error instanceof Error && "killed" in error) {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const text = await fs.readFile(safeFilePath, "utf-8");
        const lines = text.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = lines.slice(0, limit);
            truncated.push(`... (${lines.length - limit} more lines)`);
            return truncated.join("\n");
        }

        return text.slice(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const directory = path.dirname(safeFilePath);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(safeFilePath, content, "utf-8");
        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runEdit(
    filePath: string,
    oldText: string,
    newText: string
): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");

        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        const newContent = content.replace(oldText, newText);
        await fs.writeFile(safeFilePath, newContent, "utf-8");

        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Message types
 */
interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

interface ContentBlock {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
    tool_use_id?: string;
    content?: string;
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

/**
 * Tool handler type
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * THE DISPATCH MAP: Now includes compact handler!
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => {
        const command = input.command as string;
        return runBash(command);
    },

    read_file: async (input) => {
        const filePath = input.path as string;
        const limit = input.limit as number | undefined;
        return runRead(filePath, limit);
    },

    write_file: async (input) => {
        const filePath = input.path as string;
        const content = input.content as string;
        return runWrite(filePath, content);
    },

    edit_file: async (input) => {
        const filePath = input.path as string;
        const oldText = input.old_text as string;
        const newText = input.new_text as string;
        return runEdit(filePath, oldText, newText);
    },

    // LAYER 3: compact tool - manual compression trigger
    // TypeScript: Returns message (same as Python)
    // Python: lambda **kw: "Manual compression requested."
    compact: async () => {
        return "Manual compression requested.";
    },
};

/**
 * Tool definitions - now includes compact!
 */
const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object" as const,
            properties: {
                command: { type: "string" },
            },
            required: ["command"] as const,
        },
    },
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                limit: { type: "integer" },
            },
            required: ["path"] as const,
        },
    },
    {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                content: { type: "string" },
            },
            required: ["path", "content"] as const,
        },
    },
    {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
            },
            required: ["path", "old_text", "new_text"] as const,
        },
    },
    {
        name: "compact",
        description: "Manually compress conversation context by summarizing and archiving.",
        input_schema: {
            type: "object" as const,
            properties: {},
            required: [] as const,
        },
    },
];

/**
 * Agent loop with context compression
 *
 * NEW: Three-layer compression pipeline
 * 1. micro_compact after every tool result
 * 2. auto_compact when tokens exceed threshold
 * 3. compact tool for manual triggering
 */
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        // LAYER 1: micro_compact every turn (silent)
        // TypeScript: Function call mutates messages
        // Python: messages = micro_compact(messages)
        microCompact(messages);

        // LAYER 2: auto_compact if over threshold
        // TypeScript: await async function
        // Python: if estimate_tokens(messages) > THRESHOLD: messages = await auto_compact(messages)
        if (estimateTokens(messages) > THRESHOLD) {
            console.log("[auto-compacting context...]");
            messages = await autoCompact(messages);
        }

        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens: 8000,
        });

        messages.push({
            role: "assistant",
            content: response.content,
        });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results: ToolResultBlock[] = [];
        let compactRequested = false;

        for (const block of response.content) {
            if (block.type === "tool_use" && block.id && block.name && block.input) {
                console.log(`> ${block.name}:`);

                const handler = TOOL_HANDLERS[block.name];
                let output: string;

                if (handler) {
                    try {
                        output = await handler(block.input);
                    } catch (error) {
                        output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
                    }
                } else {
                    output = `Unknown tool: ${block.name}`;
                }

                console.log(output.slice(0, 200));

                // LAYER 3: Check if compact was manually requested
                // TypeScript: String comparison
                // Python: if block.name == "compact"
                if (block.name === "compact") {
                    compactRequested = true;
                }

                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
        }

        messages.push({
            role: "user",
            content: results,
        });

        // If compact was manually requested, trigger auto_compact
        if (compactRequested) {
            console.log("[manual compact triggered...]");
            messages = await autoCompact(messages);
        }
    }
}

/**
 * Main REPL loop
 */
async function main(): Promise<void> {
    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 6: Context Compact. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms06 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                break;
            }

            history.push({
                role: "user",
                content: query,
            });

            await agentLoop(history);

            const responseContent = history[history.length - 1].content;
            if (Array.isArray(responseContent)) {
                for (const block of responseContent) {
                    if ("text" in block && typeof block.text === "string") {
                        console.log(block.text);
                    }
                }
            }
            console.log();
        } catch (error) {
            if (
                error instanceof Error &&
                (error.message.includes("EOF") || error.message.includes("SIGINT"))
            ) {
                break;
            }
            console.error("Error:", error);
        }
    }

    rl.close();
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
