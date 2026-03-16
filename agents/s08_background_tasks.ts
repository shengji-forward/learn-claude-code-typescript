#!/usr/bin/env ts-node
/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background worker threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Worker thread
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. CONCURRENCY MODEL:
 *    - Python: threading.Thread with shared memory
 *    - TypeScript: Worker Threads with message passing
 *    - TypeScript: No shared memory, safer concurrency
 *
 * 2. THREAD COMMUNICATION:
 *    - Python: Direct access to shared objects (with locks)
 *    - TypeScript: postMessage/on('message') events
 *    - TypeScript: Structured clone algorithm for data transfer
 *
 * 3. NOTIFICATION QUEUE:
 *    - Python: threading.Lock() for queue access
 *    - TypeScript: Array is sufficient (single-threaded event loop)
 *    - TypeScript: No locks needed due to event loop model
 *
 * 4. THREAD LIFECYCLE:
 *    - Python: Daemon threads auto-exit with main thread
 *    - TypeScript: Workers must be explicitly terminated
 *    - TypeScript: worker.terminate() kills worker immediately
 *
 * 5. FILE PATHS:
 *    - Python: Path objects for cross-platform paths
 *    - TypeScript: path.join() for cross-platform paths
 *    - TypeScript: Must use .js extension in Worker path (compiled output)
 *
 * 6. ERROR HANDLING:
 *    - Python: Exception propagates, can be caught in thread
 *    - TypeScript: Worker 'error' event must be handled
 *    - TypeScript: Uncaught errors terminate worker
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import { Worker } from "worker_threads";

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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

const execAsync = promisify(exec);

/**
 * Task status enum
 * TypeScript: enum for compile-time type safety
 * Python: String literals with no compile-time checking
 */
enum TaskStatus {
    RUNNING = "running",
    COMPLETED = "completed",
    TIMEOUT = "timeout",
    ERROR = "error",
}

/**
 * Task interface
 * TypeScript: Interface defines task structure
 * Python: Would use dict or TypedDict
 */
interface Task {
    status: TaskStatus;
    result: string | null;
    command: string;
}

/**
 * Notification interface
 * TypeScript: Interface for notification queue items
 */
interface Notification {
    task_id: string;
    status: string;
    command: string;
    result: string;
}

/**
 * BackgroundManager: threaded execution + notification queue
 * TypeScript: Class with Worker management
 * Python: Class with threading.Thread management
 */
class BackgroundManager {
    private tasks: Map<string, Task> = new Map();
    private notificationQueue: Notification[] = [];
    private workers: Map<string, Worker> = new Map();

    /**
     * Run a command in background thread
     * TypeScript: Creates Worker instance, returns immediately
     * Python: Creates Thread, starts it, returns immediately
     */
    run(command: string): string {
        const taskId = this.generateTaskId();

        this.tasks.set(taskId, {
            status: TaskStatus.RUNNING,
            result: null,
            command,
        });

        // Create worker thread
        const workerPath = path.join(__dirname, "..", "workers", "task-worker.js");
        const worker = new Worker(workerPath, {
            workerData: {
                taskId,
                command,
                workdir: WORKDIR,
                timeout: 300000,
            },
        });

        // Handle worker messages
        worker.on("message", (result: Notification) => {
            const task = this.tasks.get(taskId);
            if (task) {
                task.status = result.status as TaskStatus;
                task.result = result.result;

                this.notificationQueue.push({
                    task_id: result.task_id,
                    status: result.status,
                    command: result.command,
                    result: result.result.substring(0, 500),
                });
            }
        });

        // Handle worker errors
        worker.on("error", (error) => {
            const task = this.tasks.get(taskId);
            if (task) {
                task.status = TaskStatus.ERROR;
                task.result = `Error: ${error.message}`;
            }
        });

        // Clean up worker on exit
        worker.on("exit", (code) => {
            if (code !== 0) {
                const task = this.tasks.get(taskId);
                if (task && task.status === TaskStatus.RUNNING) {
                    task.status = TaskStatus.ERROR;
                    task.result = `Worker exited with code ${code}`;
                }
            }
            this.workers.delete(taskId);
        });

        this.workers.set(taskId, worker);

        return `Background task ${taskId} started: ${command.substring(0, 80)}`;
    }

    /**
     * Check status of one task or list all
     * TypeScript: Method with optional parameter
     * Python: Method with default None parameter
     */
    check(taskId?: string): string {
        if (taskId) {
            const task = this.tasks.get(taskId);
            if (!task) {
                return `Error: Unknown task ${taskId}`;
            }
            const result = task.result || "(running)";
            return `[${task.status}] ${task.command.substring(0, 60)}\n${result}`;
        }

        // List all tasks
        const lines: string[] = [];
        for (const [tid, task] of Array.from(this.tasks.entries())) {
            lines.push(`${tid}: [${task.status}] ${task.command.substring(0, 60)}`);
        }
        return lines.length > 0 ? lines.join("\n") : "No background tasks.";
    }

    /**
     * Return and clear all pending completion notifications
     * TypeScript: Simple array operation (no locks needed in Node.js)
     * Python: Must use threading.Lock to protect queue access
     */
    drainNotifications(): Notification[] {
        const notifs = [...this.notificationQueue];
        this.notificationQueue = [];
        return notifs;
    }

    /**
     * Generate short task ID
     * TypeScript: Private helper method
     * Python: Would use uuid.uuid4()[:8]
     */
    private generateTaskId(): string {
        return Math.random().toString(36).substring(2, 10);
    }

    /**
     * Terminate all workers (cleanup)
     * TypeScript: Explicit cleanup required
     * Python: Daemon threads auto-clean
     */
    terminateAll(): void {
        for (const [taskId, worker] of Array.from(this.workers.entries())) {
            worker.terminate();
            this.workers.delete(taskId);
        }
    }
}

// Initialize background manager
const BG = new BackgroundManager();

// -- Base tool implementations --
/**
 * Safe path resolution
 * TypeScript: Explicit type annotations
 * Python: Type hints with Path
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
 * TypeScript: Async function with timeout
 * Python: Synchronous subprocess.run
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
 * TypeScript: Async function with optional limit
 * Python: Synchronous function with default None
 */
async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        const lines = content.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = [
                ...lines.slice(0, limit),
                `... (${lines.length - limit} more)`
            ];
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
 * TypeScript: Record type with explicit handler types
 * Python: Dict with lambda functions
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => await runBash(input.command),
    read_file: async (input) => await runRead(input.path, input.limit),
    write_file: async (input) => await runWrite(input.path, input.content),
    edit_file: async (input) => await runEdit(input.path, input.old_text, input.new_text),
    background_run: (input) => BG.run(input.command),
    check_background: (input) => BG.check(input.task_id),
};

/**
 * Tool definitions for the API
 * TypeScript: Array of tool definition objects
 * Python: List of dicts
 */
const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command (blocking).",
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
        name: "background_run",
        description: "Run command in background thread. Returns task_id immediately.",
        input_schema: {
            type: "object" as const,
            properties: {
                command: { type: "string" }
            },
            required: ["command"] as const
        }
    },
    {
        name: "check_background",
        description: "Check background task status. Omit task_id to list all.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "string" }
            }
        }
    },
];

/**
 * Agent loop with notification draining
 * TypeScript: Async function with Message interface
 * Python: Synchronous function with list of dicts
 */
async function agentLoop(messages: any[]): Promise<void> {
    while (true) {
        // Drain background notifications and inject as system message before LLM call
        const notifs = BG.drainNotifications();
        if (notifs.length > 0 && messages.length > 0) {
            const notifText = notifs
                .map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
                .join("\n");

            messages.push({
                role: "user",
                content: `<background-results>\n${notifText}\n</background-results>`
            });
            messages.push({
                role: "assistant",
                content: "Noted background results."
            });
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

    console.log("\nSession 8: Background Tasks");
    console.log("Long-running commands execute in worker threads without blocking.\n");

    try {
        while (true) {
            const query = await question("\x1b[36ms08 >> \x1b[0m");

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
    } finally {
        // Clean up workers on exit
        BG.terminateAll();
        rl.close();
    }
}

// Run the main function
main().catch(console.error);
