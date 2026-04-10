#!/usr/bin/env ts-node
// Harness: resilience -- a robust agent recovers instead of crashing.
// @ts-nocheck
/**
 * s11_error_recovery.ts - Error Recovery
 *
 * Teaching demo of three recovery paths:
 *
 * - continue when output is truncated
 * - compact when context grows too large
 * - back off when transport errors are temporary
 *
 *     LLM response
 *          |
 *          v
 *     [Check stop_reason]
 *          |
 *          +-- "max_tokens" ----> [Strategy 1: max_output_tokens recovery]
 *          |                       Inject continuation message:
 *          |                       "Output limit hit. Continue directly."
 *          |                       Retry up to MAX_RECOVERY_ATTEMPTS (3).
 *          |                       Counter: max_output_recovery_count
 *          |
 *          +-- API error -------> [Check error type]
 *          |                       |
 *          |                       +-- prompt_too_long --> [Strategy 2: compact + retry]
 *          |                       |   Trigger auto_compact (LLM summary).
 *          |                       |   Replace history with summary.
 *          |                       |   Retry the turn.
 *          |                       |
 *          |                       +-- connection/rate --> [Strategy 3: backoff retry]
 *          |                           Exponential backoff: base * 2^attempt + jitter
 *          |                           Up to 3 retries.
 *          |
 *          +-- "end_turn" -----> [Normal exit]
 *
 *     Recovery priority (first match wins):
 *     1. max_tokens -> inject continuation, retry
 *     2. prompt_too_long -> compact, retry
 *     3. connection error -> backoff, retry
 *     4. all retries exhausted -> fail gracefully
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. ERROR HANDLING:
 *    - Python: except APIError as e for Anthropic errors
 *    - TypeScript: catch with err instanceof APIError
 *    - TypeScript needs import { APIError } from "@anthropic-ai/sdk"
 *
 * 2. SLEEP/DELAY:
 *    - Python: time.sleep(delay) - synchronous blocking
 *    - TypeScript: await new Promise(resolve => setTimeout(resolve, delay * 1000))
 *    - TypeScript requires async approach with Promise-wrapped setTimeout
 *
 * 3. ARRAY MUTATION:
 *    - Python: messages[:] = auto_compact(messages) - in-place replacement
 *    - TypeScript: messages.splice(0, messages.length, ...autoCompact(messages))
 *    - TypeScript array mutation is explicit
 *
 * 4. RANDOM:
 *    - Python: random.uniform(0, 1) for jitter
 *    - TypeScript: Math.random() for jitter
 */

import Anthropic, { APIError } from "@anthropic-ai/sdk";
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

// Recovery constants
const MAX_RECOVERY_ATTEMPTS = 3;
const BACKOFF_BASE_DELAY = 1.0;  // seconds
const BACKOFF_MAX_DELAY = 30.0;  // seconds
const TOKEN_THRESHOLD = 50000;   // chars / 4 ~ tokens for compact trigger

const CONTINUATION_MESSAGE = (
    "Output limit hit. Continue directly from where you stopped -- " +
    "no recap, no repetition. Pick up mid-sentence if needed."
);

/**
 * Rough token estimate: ~4 chars per token.
 * TypeScript: JSON.stringify with replacer, Math.floor
 * Python: len(json.dumps(messages, default=str)) // 4
 */
function estimateTokens(messages: Message[]): number {
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
 * Compress conversation history into a short continuation summary.
 *
 * TypeScript: async function returning new Message array
 * Python: def auto_compact(messages: list) -> list
 */
async function autoCompact(messages: Message[]): Promise<Message[]> {
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

    const prompt = (
        "Summarize this conversation for continuity. Include:\n" +
        "1) Task overview and success criteria\n" +
        "2) Current state: completed work, files touched\n" +
        "3) Key decisions and failed approaches\n" +
        "4) Remaining next steps\n" +
        "Be concise but preserve critical details.\n\n" +
        conversationText
    );

    let summary: string;
    try {
        const response = await client.messages.create({
            model: MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 4000,
        });
        // Collect text from all text blocks
        summary = response.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n")
            .trim();
    } catch (error) {
        summary = `(compact failed: ${error instanceof Error ? error.message : "Unknown error"}). Previous context lost.`;
    }

    const continuation = (
        "This session continues from a previous conversation that was compacted. " +
        `Summary of prior context:\n\n${summary}\n\n` +
        "Continue from where we left off without re-asking the user."
    );

    return [{ role: "user", content: continuation }];
}

/**
 * Exponential backoff with jitter: base * 2^attempt + random(0, 1).
 *
 * TypeScript: Math.random() returns [0, 1)
 * Python: random.uniform(0, 1) returns [0, 1)
 */
function backoffDelay(attempt: number): number {
    const delay = Math.min(BACKOFF_BASE_DELAY * Math.pow(2, attempt), BACKOFF_MAX_DELAY);
    const jitter = Math.random();
    return delay + jitter;
}

/**
 * Sleep helper for async delay.
 * TypeScript: Promise-wrapped setTimeout
 * Python: time.sleep(delay) (synchronous)
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe path validation
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
 * Types for message handling
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
 * THE DISPATCH MAP
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
};

/**
 * Tool definitions for Anthropic API
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
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

/**
 * Error-recovering agent loop with three paths:
 *
 * 1. continue after max_tokens
 * 2. compact after prompt-too-long
 * 3. back off after transient transport failure
 *
 * TypeScript: async function with try/catch error handling
 * Python: def agent_loop(messages: list)
 *
 * Key differences:
 * - TypeScript uses err instanceof APIError for Anthropic SDK errors
 * - TypeScript uses err instanceof Error for connection errors
 * - Sleep is await-based (non-blocking) instead of time.sleep()
 * - Array mutation uses splice for in-place replacement
 */
async function agentLoop(messages: Message[]): Promise<void> {
    let maxOutputRecoveryCount = 0;

    while (true) {
        // -- Attempt the API call with connection retry --
        let response: any = null;

        for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
            try {
                response = await client.messages.create({
                    model: MODEL,
                    system: SYSTEM,
                    messages: messages,
                    tools: TOOLS,
                    max_tokens: 8000,
                });
                break; // success

            } catch (err) {
                // Strategy 2: prompt_too_long -> compact and retry
                if (err instanceof APIError) {
                    const errorBody = String(err).toLowerCase();

                    if (
                        errorBody.includes("overlong_prompt") ||
                        (errorBody.includes("prompt") && errorBody.includes("long"))
                    ) {
                        console.log(`[Recovery] Prompt too long. Compacting... (attempt ${attempt + 1})`);
                        const compacted = await autoCompact(messages);
                        messages.splice(0, messages.length, ...compacted);
                        continue;
                    }

                    // Strategy 3: connection/rate errors -> backoff
                    if (attempt < MAX_RECOVERY_ATTEMPTS) {
                        const delay = backoffDelay(attempt);
                        console.log(
                            `[Recovery] API error: ${err}. ` +
                            `Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`
                        );
                        await sleep(delay * 1000);
                        continue;
                    }

                    // All retries exhausted
                    console.log(`[Error] API call failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${err}`);
                    return;
                }

                // Strategy 3: network-level errors -> backoff
                // TypeScript: err instanceof Error for connection errors
                // Python: except (ConnectionError, TimeoutError, OSError) as e
                if (err instanceof Error) {
                    if (attempt < MAX_RECOVERY_ATTEMPTS) {
                        const delay = backoffDelay(attempt);
                        console.log(
                            `[Recovery] Connection error: ${err.message}. ` +
                            `Retrying in ${delay.toFixed(1)}s (attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`
                        );
                        await sleep(delay * 1000);
                        continue;
                    }

                    console.log(`[Error] Connection failed after ${MAX_RECOVERY_ATTEMPTS} retries: ${err.message}`);
                    return;
                }

                // Unknown error type
                console.log(`[Error] Unexpected error: ${err}`);
                return;
            }
        }

        if (response === null) {
            console.log("[Error] No response received.");
            return;
        }

        messages.push({
            role: "assistant",
            content: response.content,
        });

        // -- Strategy 1: max_tokens recovery --
        if (response.stop_reason === "max_tokens") {
            maxOutputRecoveryCount++;
            if (maxOutputRecoveryCount <= MAX_RECOVERY_ATTEMPTS) {
                console.log(
                    `[Recovery] max_tokens hit ` +
                    `(${maxOutputRecoveryCount}/${MAX_RECOVERY_ATTEMPTS}). ` +
                    "Injecting continuation..."
                );
                messages.push({ role: "user", content: CONTINUATION_MESSAGE });
                continue; // retry the loop
            } else {
                console.log(
                    `[Error] max_tokens recovery exhausted ` +
                    `(${MAX_RECOVERY_ATTEMPTS} attempts). Stopping.`
                );
                return;
            }
        }

        // Reset max_tokens counter on successful non-max_tokens response
        maxOutputRecoveryCount = 0;

        // -- Normal end_turn: no tool use requested --
        if (response.stop_reason !== "tool_use") {
            return;
        }

        // -- Process tool calls --
        const results: ToolResultBlock[] = [];

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

        // Check if we should auto-compact (proactive, not just reactive)
        if (estimateTokens(messages) > TOKEN_THRESHOLD) {
            console.log("[Recovery] Token estimate exceeds threshold. Auto-compacting...");
            const compacted = await autoCompact(messages);
            messages.splice(0, messages.length, ...compacted);
        }
    }
}

/**
 * Main REPL loop
 */
async function main(): Promise<void> {
    console.log("[Error recovery enabled: max_tokens / prompt_too_long / connection backoff]");

    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 11: Error Recovery. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms11 >> \x1b[0m");

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
