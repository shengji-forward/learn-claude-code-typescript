#!/usr/bin/env ts-node
// Harness: tool dispatch -- expanding what the model can reach.
// @ts-nocheck
/**
 * s02_tool_use.ts - Tools
 *
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 *
 *     +----------+      +-------+      +------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch   |
 *     |  prompt  |      |       |      | {               |
 *     +----------+      +---+---+      |   bash: runBash |
 *                           |          |   read: runRead |
 *                           |          |   write: runWr  |
 *                           +----------+   edit: runEdit |
 *                           tool_result| }               |
 *                                      +------------------+
 *
 * Key insight: "The loop didn't change at all. I just added tools."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. TOOL HANDLERS MAP:
 *    - Python: TOOL_HANDLERS = {"bash": lambda **kw: run_bash(kw["command"]), ...}
 *    - TypeScript: Record<string, ToolHandler> with proper function types
 *    - Uses arrow functions with type-safe parameters
 *
 * 2. IMPORTS:
 *    - Python: from pathlib import Path
 *    - TypeScript: import path from "path" (built-in Node.js module)
 *
 * 3. TYPE SAFETY:
 *    - Python: Runtime type checking with isinstance()
 *    - TypeScript: Compile-time type checking with interfaces
 *    - Discriminated unions for content blocks
 *
 * 4. ERROR HANDLING:
 *    - Python: try/except with Exception as e
 *    - TypeScript: try/catch with error instanceof Error
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// Promisify exec for async/await
const execAsync = promisify(exec);

/**
 * Safe path validation
 *
 * TypeScript: Returns string (absolute path)
 * Python: Returns Path object
 *
 * TypeScript uses path.resolve() and path.relative() for path operations
 * Python uses pathlib.Path with is_relative_to() method
 */
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    // Check if path escapes working directory
    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

/**
 * Bash tool handler
 * TypeScript: async function returning Promise<string>
 * Python: def run_bash(command: str) -> str
 */
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

/**
 * File read tool handler
 * TypeScript: async function with optional limit parameter
 * Python: def run_read(path: str, limit: int = None) -> str
 */
async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const text = await fs.readFile(safeFilePath, "utf-8");
        const lines = text.split("\n");

        // Apply line limit if specified
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

/**
 * File write tool handler
 * TypeScript: async function with void return (string output for logging)
 * Python: def run_write(path: str, content: str) -> str
 */
async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);

        // Create parent directories if they don't exist
        // TypeScript: fs.mkdir with recursive option
        // Python: fp.parent.mkdir(parents=True, exist_ok=True)
        const directory = path.dirname(safeFilePath);
        await fs.mkdir(directory, { recursive: true });

        await fs.writeFile(safeFilePath, content, "utf-8");

        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * File edit tool handler
 * TypeScript: async function
 * Python: def run_edit(path: str, old_text: str, new_text: str) -> str
 */
async function runEdit(
    filePath: string,
    oldText: string,
    newText: string
): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");

        // Check if old text exists
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        // Replace only first occurrence (like Python's replace with count=1)
        const newContent = content.replace(oldText, newText);

        await fs.writeFile(safeFilePath, newContent, "utf-8");

        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Tool handler type
 * TypeScript: Function type with specific signature
 * Python: Callable with **kwargs
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * THE DISPATCH MAP: {tool_name: handler}
 *
 * TypeScript: Record<string, ToolHandler> - a typed object with string keys
 * Python: TOOL_HANDLERS = {"bash": lambda **kw: ..., "read": lambda **kw: ...}
 *
 * Key differences:
 * - TypeScript uses Record type for type-safe key-value pairs
 * - Each handler is an async function returning Promise<string>
 * - Arrow functions capture the handler functions with closures
 * - Type inference ensures handlers match the ToolHandler type
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    // TypeScript: Arrow function with destructuring and type assertion
    // Python: lambda **kw: run_bash(kw["command"])
    bash: async (input) => {
        const command = input.command as string;
        return runBash(command);
    },

    // TypeScript: Optional chaining and type assertions
    // Python: lambda **kw: run_read(kw["path"], kw.get("limit"))
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
 * TypeScript: Array of tool definition objects
 * Python: TOOLS = [{...}, {...}, ...]
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
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

/**
 * THE CORE PATTERN: Agent loop (unchanged from s01!)
 *
 * The loop didn't change at all. We just added tools to the dispatch map.
 * This is the beauty of the pattern: extensibility without modification.
 *
 * TypeScript: async function with type-safe handler dispatch
 * Python: def agent_loop(messages: list) - same structure
 */
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens: 8000,
        });

        // Append assistant turn
        messages.push({
            role: "assistant",
            content: response.content,
        });

        // If the model didn't call a tool, we're done
        if (response.stop_reason !== "tool_use") {
            return;
        }

        // Execute each tool call, collect results
        const results: ToolResultBlock[] = [];

        for (const block of response.content) {
            // TypeScript: Type guard for tool_use blocks
            // Python: if block.type == "tool_use"
            if (block.type === "tool_use" && block.id && block.name && block.input) {
                console.log(`> ${block.name}:`);

                // TypeScript: Get handler from map, execute with type safety
                // Python: handler = TOOL_HANDLERS.get(block.name); output = handler(**block.input)
                const handler = TOOL_HANDLERS[block.name];
                let output: string;

                if (handler) {
                    output = await handler(block.input);
                } else {
                    output = `Unknown tool: ${block.name}`;
                }

                console.log(output.slice(0, 200));

                // TypeScript: Type-safe tool result object
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
        }

        // Append tool results as user message
        messages.push({
            role: "user",
            content: results,
        });
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

    console.log("Session 2: Tool Use. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms02 >> \x1b[0m");

            if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
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
