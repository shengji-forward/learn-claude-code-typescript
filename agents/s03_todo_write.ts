#!/usr/bin/env ts-node
// Harness: planning -- keeping the model on course without scripting the route.
// @ts-nocheck
/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                                 |
 *                     +-----------+-----------+
 *                     | TodoManager state     |
 *                     | [ ] task A            |
 *                     | [>] task B <- doing   |
 *                     | [x] task C            |
 *                     +-----------------------+
 *                                 |
 *                     if rounds_since_todo >= 3:
 *                       inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. CLASS DEFINITIONS:
 *    - Python: class TodoManager with __init__ method
 *    - TypeScript: class with constructor and property types
 *    - TypeScript requires explicit property declarations
 *
 * 2. ENUM USAGE:
 *    - Python: String literals for status ("pending", "in_progress", "completed")
 *    - TypeScript: enum for compile-time type safety
 *
 * 3. TYPE VALIDATION:
 *    - Python: Runtime type checking with isinstance()
 *    - TypeScript: Compile-time type checking + runtime validation
 *    - Both need runtime validation for API inputs
 *
 * 4. STATE MANAGEMENT:
 *    - Python: Instance variables (self.items = [])
 *    - TypeScript: Class properties with type annotations
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

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

const execAsync = promisify(exec);

/**
 * Todo status enum
 * TypeScript: enum provides compile-time type safety
 * Python: String literals (no compile-time checking)
 */
enum TodoStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Todo item interface
 * TypeScript: Interface defines shape at compile time
 * Python: Would use TypedDict or runtime dict
 */
interface TodoItem {
    id: string;
    text: string;
    status: TodoStatus;
}

/**
 * Todo item input (from API)
 * TypeScript: Optional fields marked with ?
 * Python: Dict with all keys optional
 */
interface TodoItemInput {
    id?: string;
    text: string;
    status?: string;
}

/**
 * TodoManager: Structured state the LLM writes to
 *
 * TypeScript: Class with typed properties and methods
 * Python: class TodoManager: with __init__, update, render
 *
 * Key differences:
 * - TypeScript requires explicit property declarations (private items: TodoItem[])
 * - Constructor parameter types are mandatory
 * - Method return types are explicitly declared
 */
class TodoManager {
    // TypeScript: private property with type
    // Python: self.items = [] (in __init__)
    private items: TodoItem[] = [];

    /**
     * Update todo items with validation
     * TypeScript: Typed parameter and return type
     * Python: def update(self, items: list) -> str
     */
    update(itemsInput: TodoItemInput[]): string {
        // Validate max items
        if (itemsInput.length > 20) {
            throw new Error("Max 20 todos allowed");
        }

        const validated: TodoItem[] = [];
        let inProgressCount = 0;

        // Validate each item
        // TypeScript: for...of loop with explicit index
        // Python: for i, item in enumerate(items)
        for (let i = 0; i < itemsInput.length; i++) {
            const item = itemsInput[i];
            const text = String(item.text || "").trim();
            const statusStr = String(item.status || "pending").toLowerCase();
            const itemId = String(item.id || String(i + 1));

            // Validate text
            if (!text) {
                throw new Error(`Item ${itemId}: text required`);
            }

            // Validate status
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

            // Count in_progress items
            if (status === TodoStatus.IN_PROGRESS) {
                inProgressCount++;
            }

            validated.push({
                id: itemId,
                text,
                status,
            });
        }

        // Validate only one in_progress
        if (inProgressCount > 1) {
            throw new Error("Only one task can be in_progress at a time");
        }

        // Update internal state
        this.items = validated;

        // Return rendered output
        return this.render();
    }

    /**
     * Render todo items as formatted string
     * TypeScript: Returns string
     * Python: def render(self) -> str
     */
    render(): string {
        if (this.items.length === 0) {
            return "No todos.";
        }

        const lines: string[] = [];

        // Map status to marker
        // TypeScript: Record type for index signature
        // Python: Dict with literal keys
        const markers: Record<TodoStatus, string> = {
            [TodoStatus.PENDING]: "[ ]",
            [TodoStatus.IN_PROGRESS]: "[>]",
            [TodoStatus.COMPLETED]: "[x]",
        };

        // Render each item
        for (const item of this.items) {
            const marker = markers[item.status];
            lines.push(`${marker} #${item.id}: ${item.text}`);
        }

        // Add completion summary
        const completed = this.items.filter(
            (t) => t.status === TodoStatus.COMPLETED
        ).length;
        lines.push(`\n(${completed}/${this.items.length} completed)`);

        return lines.join("\n");
    }
}

// Create singleton instance
// TypeScript: const with class instantiation
// Python: TODO = TodoManager()
const TODO = new TodoManager();

/**
 * Tool implementations (same as s02)
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

/**
 * THE DISPATCH MAP: Now includes todo handler!
 *
 * TypeScript: Record type with all tool handlers
 * Python: TOOL_HANDLERS = {..., "todo": lambda **kw: TODO.update(kw["items"])}
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

    // TypeScript: Todo handler using class method
    // Python: lambda **kw: TODO.update(kw["items"])
    todo: async (input) => {
        const items = input.items as TodoItemInput[];
        return TODO.update(items);
    },
};

/**
 * Tool definitions - now includes todo!
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
 * Agent loop with reminder system
 *
 * NEW: Tracks rounds since last todo update and injects reminders
 *
 * TypeScript: Parameter for rounds counter
 * Python: Uses closure variable or instance variable
 */
async function agentLoop(
    messages: Message[],
    roundsSinceTodo: { value: number }
): Promise<void> {
    // Inject reminder if needed
    // TypeScript: Check rounds counter
    // Python: if rounds_since_todo >= 3
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

                // Track if todo was used
                // TypeScript: String comparison
                // Python: if block.name == "todo"
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

        // Reset counter if todo was used
        // TypeScript: Conditional assignment
        // Python: rounds_since_todo = 0 if todo_used else rounds_since_todo + 1
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

    console.log("Session 3: Todo Write. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms03 >> \x1b[0m");

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
