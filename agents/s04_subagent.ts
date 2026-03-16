#!/usr/bin/env ts-node
/**
 * s04_subagent.ts - Subagent
 *
 * Break big tasks down; each subtask gets a clean context.
 *
 *     +----------+      +-------+      +------------------+
 *     |   User   | ---> | Agent | ---> | Subagent Task    |
 *     |  prompt  |      |       |      | (isolated msg[]) |
 *     +----------+      +---+---+      +---------+--------+
 *                           |                     |
 *                           |                     v
 *                           |               +-----------+
 *                           |               | Subagent   |
 *                           |               | completes  |
 *                           |               +-----------+
 *                           |                     |
 *                           v                     v
 *                     +-------------------------------------+
 *                     | Main context stays clean            |
 *                     | (no subagent pollution)             |
 *                     +-------------------------------------+
 *
 * Key insight: "Subagents use independent messages[], keeping the main conversation clean"
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. DEEP CLONING:
 *    - Python: copy.deepcopy(messages) or [msg.copy() for msg in messages]
 *    - TypeScript: JSON.parse(JSON.stringify(messages)) - built-in deep clone
 *    - Or structuredClone() for modern Node.js
 *
 * 2. CONTEXT ISOLATION:
 *    - Python: Pass list copy to subagent function
 *    - TypeScript: Create new array with spread or map for immutability
 *
 * 3. ASYNC SUBAGENTS:
 *    - Python: asyncio.create_task() for concurrent subagents
 *    - TypeScript: Promise.all() or Promise.allSettled() for concurrent execution
 *
 * 4. TYPE PRESERVATION:
 *    - Python: Runtime type preservation with copy
 *    - TypeScript: Must ensure types are preserved through cloning
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
const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

const execAsync = promisify(exec);

/**
 * Deep clone utility for context isolation
 *
 * TypeScript: JSON.parse(JSON.stringify()) for deep cloning
 * Python: copy.deepcopy() or [msg.copy() for msg in messages]
 *
 * Note: JSON.stringify/stringify loses non-JSON data (functions, undefined)
 * For production, use structuredClone() or a proper deep clone library
 */
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Todo status enum
 */
enum TodoStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Todo item interfaces
 */
interface TodoItem {
    id: string;
    text: string;
    status: TodoStatus;
}

interface TodoItemInput {
    id?: string;
    text: string;
    status?: string;
}

/**
 * TodoManager class
 */
class TodoManager {
    private items: TodoItem[] = [];

    update(itemsInput: TodoItemInput[]): string {
        if (itemsInput.length > 20) {
            throw new Error("Max 20 todos allowed");
        }

        const validated: TodoItem[] = [];
        let inProgressCount = 0;

        for (let i = 0; i < itemsInput.length; i++) {
            const item = itemsInput[i];
            const text = String(item.text || "").trim();
            const statusStr = String(item.status || "pending").toLowerCase();
            const itemId = String(item.id || String(i + 1));

            if (!text) {
                throw new Error(`Item ${itemId}: text required`);
            }

            if (
                ![
                    TodoStatus.PENDING,
                    TodoStatus.IN_PROGRESS,
                    TodoStatus.COMPLETED,
                ].includes(statusStr as TodoStatus)
            ) {
                throw new Error(`Item ${itemId}: invalid status '${statusStr}'`);
            }

            const status = statusStr as TodoStatus;

            if (status === TodoStatus.IN_PROGRESS) {
                inProgressCount++;
            }

            validated.push({
                id: itemId,
                text,
                status,
            });
        }

        if (inProgressCount > 1) {
            throw new Error("Only one task can be in_progress at a time");
        }

        this.items = validated;
        return this.render();
    }

    render(): string {
        if (this.items.length === 0) {
            return "No todos.";
        }

        const lines: string[] = [];
        const markers: Record<TodoStatus, string> = {
            [TodoStatus.PENDING]: "[ ]",
            [TodoStatus.IN_PROGRESS]: "[>]",
            [TodoStatus.COMPLETED]: "[x]",
        };

        for (const item of this.items) {
            const marker = markers[item.status];
            lines.push(`${marker} #${item.id}: ${item.text}`);
        }

        const completed = this.items.filter(
            (t) => t.status === TodoStatus.COMPLETED
        ).length;
        lines.push(`\n(${completed}/${this.items.length} completed)`);

        return lines.join("\n");
    }
}

const TODO = new TodoManager();

/**
 * Tool implementations (same as s03)
 */
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

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
 * Tool handler type
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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

    todo: async (input) => {
        const items = input.items as TodoItemInput[];
        return TODO.update(items);
    },
};

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
        name: "todo",
        description: "Update todo list. Use to plan and track progress on multi-step tasks.",
        input_schema: {
            type: "object" as const,
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            text: { type: "string" },
                            status: {
                                type: "string",
                                enum: [
                                    TodoStatus.PENDING,
                                    TodoStatus.IN_PROGRESS,
                                    TodoStatus.COMPLETED,
                                ],
                            },
                        },
                        required: ["text"],
                    },
                },
            },
            required: ["items"] as const,
        },
    },
];

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
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

/**
 * SUBAGENT: Isolated agent execution context
 *
 * NEW FEATURE: Execute agent with isolated message context
 *
 * TypeScript: async function with deep cloning for isolation
 * Python: def subagent(messages: list) -> str (with deep copy)
 *
 * Key differences:
 * - TypeScript uses deepClone() to create independent message array
 * - Python would use copy.deepcopy() or list comprehension
 * - Both ensure main context isn't polluted by subagent execution
 *
 * The subagent:
 * 1. Gets a fresh copy of messages (isolated from main)
 * 2. Runs the agent loop to completion
 * 3. Returns only the final text response (not all intermediate steps)
 * 4. Main context stays clean!
 */
async function runSubagent(messages: Message[]): Promise<string> {
    // Deep clone messages for isolation
    // TypeScript: deepClone() creates independent copy
    // Python: sub_messages = copy.deepcopy(messages)
    const subMessages = deepClone<Message[]>(messages);

    // Run agent loop on isolated messages
    // TypeScript: await async call
    // Python: agent_loop(sub_messages)
    await agentLoop(subMessages, { value: 0 });

    // Extract final response
    // TypeScript: Get last message, check content type
    // Python: response_content = sub_messages[-1]["content"]
    const responseContent = subMessages[subMessages.length - 1].content;

    if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
            if ("text" in block && typeof block.text === "string") {
                return block.text;
            }
        }
    }

    return "";
}

/**
 * Agent loop (same as s03)
 */
async function agentLoop(
    messages: Message[],
    roundsSinceTodo: { value: number }
): Promise<void> {
    if (roundsSinceTodo.value >= 3) {
        const reminder: Message = {
            role: "user",
            content:
                "Reminder: You have an active todo list. Please update it with your progress.",
        };
        messages.push(reminder);
        roundsSinceTodo.value = 0;
    }

    while (true) {
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
        let todoUsed = false;

        for (const block of response.content) {
            if (block.type === "tool_use" && block.id && block.name && block.input) {
                console.log(`> ${block.name}:`);

                const handler = TOOL_HANDLERS[block.name];
                let output: string;

                if (handler) {
                    output = await handler(block.input);
                } else {
                    output = `Unknown tool: ${block.name}`;
                }

                console.log(output.slice(0, 200));

                if (block.name === "todo") {
                    todoUsed = true;
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

        roundsSinceTodo.value = todoUsed ? 0 : roundsSinceTodo.value + 1;
    }
}

/**
 * Main REPL loop
 */
async function main(): Promise<void> {
    const history: Message[] = [];
    const roundsSinceTodo = { value: 0 };

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 4: Subagent. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms04 >> \x1b[0m");

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

            await agentLoop(history, roundsSinceTodo);

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
