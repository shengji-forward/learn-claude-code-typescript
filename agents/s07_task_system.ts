#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. FILE OPERATIONS:
 *    - Python: pathlib.Path with synchronous methods (read_text, write_text)
 *    - TypeScript: fs/promises with async/await (readFile, writeFile)
 *    - TypeScript requires async/await for all file I/O
 *
 * 2. TYPE DEFINITIONS:
 *    - Python: Runtime dict with string keys
 *    - TypeScript: Interface with compile-time type checking
 *    - TypeScript enforces task structure at compile time
 *
 * 3. CLASS PROPERTIES:
 *    - Python: Instance variables created in __init__
 *    - TypeScript: Property declarations with explicit types
 *    - TypeScript: private/public modifiers for access control
 *
 * 4. ERROR HANDLING:
 *    - Python: try/except with Exception types
 *    - TypeScript: try/catch with instanceof type guards
 *    - TypeScript: Type narrowing for error messages
 *
 * 5. JSON HANDLING:
 *    - Python: json.loads() / json.dumps()
 *    - TypeScript: JSON.parse() / JSON.stringify()
 *    - TypeScript: Type assertions needed for parsed JSON
 *
 * 6. GLOB OPERATIONS:
 *    - Python: path.glob("*.json") returns generator
 *    - TypeScript: await fs.readdir() with filtering
 *    - TypeScript: More explicit directory iteration
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import * as path from "path";
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

const execAsync = promisify(exec);

/**
 * Task status enum
 * TypeScript: enum provides compile-time type safety and IntelliSense
 * Python: String literals with no compile-time checking
 */
enum TaskStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Task interface
 * TypeScript: Interface defines shape at compile time
 * Python: Would use TypedDict or runtime dict with no enforcement
 */
interface Task {
    id: number;
    subject: string;
    description: string;
    status: TaskStatus;
    blockedBy: number[];
    blocks: number[];
    owner: string;
}

/**
 * Task create input
 * TypeScript: Optional fields marked with ?
 */
interface TaskCreateInput {
    subject: string;
    description?: string;
}

/**
 * Task update input
 * TypeScript: All fields optional for partial updates
 */
interface TaskUpdateInput {
    status?: TaskStatus;
    addBlockedBy?: number[];
    addBlocks?: number[];
}

/**
 * TaskManager - CRUD with dependency graph, persisted as JSON files
 * TypeScript: Class with typed properties and async methods
 * Python: Class with instance variables and synchronous methods
 */
class TaskManager {
    private dir: string;
    private nextId: number;

    constructor(tasksDir: string) {
        this.dir = tasksDir;
        this.nextId = 0; // Will be initialized in async init
    }

    /**
     * Initialize the manager (must be called after constructor)
     * TypeScript: Async initialization pattern required for fs operations
     * Python: Can do all initialization in __init__ (synchronous)
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        this.nextId = (await this.maxId()) + 1;
    }

    /**
     * Get the highest task ID from existing files
     * TypeScript: Async function returning Promise<number>
     * Python: Synchronous method returning int
     */
    private async maxId(): Promise<number> {
        try {
            const files = await fs.readdir(this.dir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

            if (taskFiles.length === 0) {
                return 0;
            }

            const ids = taskFiles.map(f => {
                const match = f.match(/task_(\d+)\.json/);
                return match ? parseInt(match[1], 10) : 0;
            });

            return Math.max(...ids);
        } catch (error) {
            return 0;
        }
    }

    /**
     * Load a task from disk
     * TypeScript: Async method with typed return
     * Python: Synchronous method returning dict
     */
    private async load(taskId: number): Promise<Task> {
        const filePath = path.join(this.dir, `task_${taskId}.json`);

        try {
            const content = await fs.readFile(filePath, "utf-8");
            return JSON.parse(content) as Task;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error(`Task ${taskId} not found`);
            }
            throw error;
        }
    }

    /**
     * Save a task to disk
     * TypeScript: Async method with void return
     * Python: Synchronous method
     */
    private async save(task: Task): Promise<void> {
        const filePath = path.join(this.dir, `task_${task.id}.json`);
        await fs.writeFile(filePath, JSON.stringify(task, null, 2), "utf-8");
    }

    /**
     * Create a new task
     * TypeScript: Async method returning Promise<string>
     * Python: Synchronous method returning str
     */
    async create(subject: string, description: string = ""): Promise<string> {
        const task: Task = {
            id: this.nextId,
            subject,
            description,
            status: TaskStatus.PENDING,
            blockedBy: [],
            blocks: [],
            owner: "",
        };

        await this.save(task);
        this.nextId += 1;

        return JSON.stringify(task, null, 2);
    }

    /**
     * Get a task by ID
     * TypeScript: Async method with typed return
     * Python: Synchronous method
     */
    async get(taskId: number): Promise<string> {
        const task = await this.load(taskId);
        return JSON.stringify(task, null, 2);
    }

    /**
     * Update a task
     * TypeScript: Partial update pattern with optional parameters
     * Python: Multiple optional parameters with default None
     */
    async update(
        taskId: number,
        status?: TaskStatus,
        addBlockedBy?: number[],
        addBlocks?: number[]
    ): Promise<string> {
        const task = await this.load(taskId);

        if (status !== undefined) {
            if (!Object.values(TaskStatus).includes(status)) {
                throw new Error(`Invalid status: ${status}`);
            }
            task.status = status;

            // When a task is completed, remove it from all other tasks' blockedBy
            if (status === TaskStatus.COMPLETED) {
                await this.clearDependency(taskId);
            }
        }

        if (addBlockedBy !== undefined) {
            task.blockedBy = Array.from(new Set([...task.blockedBy, ...addBlockedBy]));
        }

        if (addBlocks !== undefined) {
            task.blocks = Array.from(new Set([...task.blocks, ...addBlocks]));

            // Bidirectional: also update the blocked tasks' blockedBy lists
            for (const blockedId of addBlocks) {
                try {
                    const blocked = await this.load(blockedId);
                    if (!blocked.blockedBy.includes(taskId)) {
                        blocked.blockedBy.push(taskId);
                        await this.save(blocked);
                    }
                } catch (error) {
                    // Task might not exist, ignore
                }
            }
        }

        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    /**
     * Remove a completed task from all other tasks' blockedBy lists
     * TypeScript: Async method iterating over directory
     * Python: Synchronous method with glob pattern
     */
    private async clearDependency(completedId: number): Promise<void> {
        try {
            const files = await fs.readdir(this.dir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

            for (const file of taskFiles) {
                const filePath = path.join(this.dir, file);
                const content = await fs.readFile(filePath, "utf-8");
                const task = JSON.parse(content) as Task;

                if (task.blockedBy.includes(completedId)) {
                    task.blockedBy = task.blockedBy.filter(id => id !== completedId);
                    await this.save(task);
                }
            }
        } catch (error) {
            // Directory might not exist yet
        }
    }

    /**
     * List all tasks with status indicators
     * TypeScript: Async method returning formatted string
     * Python: Synchronous method
     */
    async listAll(): Promise<string> {
        try {
            const files = await fs.readdir(this.dir);
            const taskFiles = files
                .filter(f => f.startsWith("task_") && f.endsWith(".json"))
                .sort();

            if (taskFiles.length === 0) {
                return "No tasks.";
            }

            const tasks: Task[] = [];
            for (const file of taskFiles) {
                const filePath = path.join(this.dir, file);
                const content = await fs.readFile(filePath, "utf-8");
                tasks.push(JSON.parse(content) as Task);
            }

            const lines: string[] = [];
            for (const task of tasks) {
                const markerMap = {
                    [TaskStatus.PENDING]: "[ ]",
                    [TaskStatus.IN_PROGRESS]: "[>]",
                    [TaskStatus.COMPLETED]: "[x]",
                };
                const marker = markerMap[task.status] || "[?]";
                const blocked = task.blockedBy.length > 0
                    ? ` (blocked by: ${task.blockedBy.join(", ")})`
                    : "";
                lines.push(`${marker} #${task.id}: ${task.subject}${blocked}`);
            }

            return lines.join("\n");
        } catch (error) {
            return "No tasks.";
        }
    }
}

// Initialize task manager (will be inited before use)
const TASKS = new TaskManager(TASKS_DIR);

// -- Base tool implementations --
/**
 * Safe path resolution
 * TypeScript: Explicit type annotations, Error type with type guard
 * Python: Type hints with Path, runtime ValueError
 */
function safePath(p: string): string {
    const resolvedPath = path.resolve(WORKDIR, p);
    if (!resolvedPath.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolvedPath;
}

/**
 * Run bash command
 * TypeScript: Async function with timeout handling
 * Python: Synchronous subprocess.run with timeout
 */
async function runBash(command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR,
            timeout: 120000,
        });
        const output = (stdout + stderr).trim();
        return output ? output.substring(0, 50000) : "(no output)";
    } catch (error) {
        if ((error as any).code === "ETIMEDOUT") {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Read file contents
 * TypeScript: Async function with optional limit parameter
 * Python: Synchronous function with default None
 */
async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        const lines = content.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
            return truncated.join("\n").substring(0, 50000);
        }

        return content.substring(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Write content to file
 * TypeScript: Async function with proper error handling
 * Python: Synchronous function
 */
async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const dir = path.dirname(safeFilePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(safeFilePath, content, "utf-8");
        return `Wrote ${content.length} bytes`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Edit file by replacing exact text
 * TypeScript: Async function with string replacement
 * Python: Synchronous function
 */
async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");

        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        const updatedContent = content.replace(oldText, newText);
        await fs.writeFile(safeFilePath, updatedContent, "utf-8");
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

// Type for tool handler functions
type ToolHandler = (input: any) => Promise<string> | string;

/**
 * Tool handlers map
 * TypeScript: Record type with string keys and ToolHandler values
 * Python: Dict with string keys and lambda/function values
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => await runBash(input.command),
    read_file: async (input) => await runRead(input.path, input.limit),
    write_file: async (input) => await runWrite(input.path, input.content),
    edit_file: async (input) => await runEdit(input.path, input.old_text, input.new_text),
    task_create: async (input) => await TASKS.create(input.subject, input.description || ""),
    task_update: async (input) => await TASKS.update(
        input.task_id,
        input.status,
        input.addBlockedBy,
        input.addBlocks
    ),
    task_list: async () => await TASKS.listAll(),
    task_get: async (input) => await TASKS.get(input.task_id),
};

/**
 * Tool definitions for the API
 * TypeScript: Array of Tool objects with explicit types
 * Python: List of dicts
 */
const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object" as const,
            properties: {
                command: { type: "string" }
            },
            required: ["command"] as const
        }
    },
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                limit: { type: "integer" }
            },
            required: ["path"] as const
        }
    },
    {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                content: { type: "string" }
            },
            required: ["path", "content"] as const
        }
    },
    {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" }
            },
            required: ["path", "old_text", "new_text"] as const
        }
    },
    {
        name: "task_create",
        description: "Create a new task.",
        input_schema: {
            type: "object" as const,
            properties: {
                subject: { type: "string" },
                description: { type: "string" }
            },
            required: ["subject"] as const
        }
    },
    {
        name: "task_update",
        description: "Update a task's status or dependencies.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "integer" },
                status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"] as const
                },
                addBlockedBy: {
                    type: "array",
                    items: { type: "integer" }
                },
                addBlocks: {
                    type: "array",
                    items: { type: "integer" }
                }
            },
            required: ["task_id"] as const
        }
    },
    {
        name: "task_list",
        description: "List all tasks with status summary.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "task_get",
        description: "Get full details of a task by ID.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "integer" }
            },
            required: ["task_id"] as const
        }
    },
];

/**
 * Agent loop
 * TypeScript: Async function with Message interface
 * Python: Synchronous function with list of dicts
 */
async function agentLoop(messages: any[]): Promise<void> {
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

        const results: any[] = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const handler = TOOL_HANDLERS[block.name];
                try {
                    const output = handler
                        ? await handler(block.input)
                        : `Unknown tool: ${block.name}`;

                    console.log(`> ${block.name}: ${String(output).substring(0, 200)}`);

                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: String(output),
                    });
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : "Unknown error";
                    console.log(`> ${block.name}: Error: ${errorMsg}`);
                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: `Error: ${errorMsg}`,
                    });
                }
            }
        }

        messages.push({
            role: "user",
            content: results,
        });
    }
}

/**
 * Main REPL loop
 * TypeScript: Async function with readline interface
 * Python: while True with input()
 */
async function main(): Promise<void> {
    // Initialize task manager before starting
    await TASKS.init();

    const history: any[] = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
            rl.question(prompt, resolve);
        });
    };

    console.log("\nSession 7: Task System");
    console.log("Tasks persist in .tasks/ directory and survive context compression.\n");

    while (true) {
        const query = await question("\x1b[36ms07 >> \x1b[0m");

        if (query.trim().toLowerCase() === "q" || query.trim() === "exit" || query.trim() === "") {
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
                if (block.type === "text") {
                    console.log(block.text);
                }
            }
        }
        console.log();
    }

    rl.close();
}

// Run the main function
main().catch(console.error);
