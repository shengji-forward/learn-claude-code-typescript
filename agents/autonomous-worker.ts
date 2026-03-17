#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * autonomous-worker.ts - Autonomous Teammate Worker
 *
 * This worker runs an autonomous teammate agent with idle cycle management.
 * It polls for tasks and auto-claims work when idle.
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. IDLE CYCLE:
 *    - Python: for loop with time.sleep()
 *    - TypeScript: Async for loop with await sleep()
 *    - TypeScript: Promise-based non-blocking delays
 *
 * 2. TASK SCANNING:
 *    - Python: scan_unclaimed_tasks() returns list
 *    - TypeScript: Async method scans .tasks/ directory
 *    - TypeScript: Filter and parse with async/await
 *
 * 3. IDENTITY RE-INJECTION:
 *    - Python: messages.insert(0, identity_block)
 *    - TypeScript: messages.unshift(identity_block)
 *    - TypeScript: Type-safe array manipulation
 *
 * 4. STATUS UPDATES:
 *    - Python: Direct method calls on TeammateManager
 *    - TypeScript: Post status change messages to parent
 *    - TypeScript: ParentPort communication pattern
 *
 * 5. POLLING BEHAVIOR:
 *    - Python: time.sleep() blocks thread
 *    - TypeScript: await sleep() doesn't block event loop
 *    - TypeScript: Other async operations can run during sleep
 */

import { parentPort, workerData } from "worker_threads";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Worker data interface
 */
interface AutonomousData {
    teammateName: string;
    role: string;
    prompt: string;
    teamName: string;
    workdir: string;
    inboxDir: string;
    tasksDir: string;
    modelId: string;
    apiBase?: string;
    pollInterval: number;
    idleTimeout: number;
}

/**
 * Task interface
 */
interface Task {
    id: number;
    subject: string;
    description: string;
    status: string;
    owner?: string;
    blockedBy?: string[];
}

/**
 * Message interface
 */
interface Message {
    type: string;
    from: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

/**
 * Initialize worker data
 */
const data = workerData as AutonomousData;
const WORKDIR = data.workdir;
const INBOX_DIR = data.inboxDir;
const TASKS_DIR = data.tasksDir;
const MODEL = data.modelId;
const POLL_INTERVAL = data.pollInterval * 1000;  // Convert to milliseconds
const IDLE_TIMEOUT = data.idleTimeout;

const client = new Anthropic(
    data.apiBase ? { baseURL: data.apiBase } : undefined
);

const SYSTEM = `You are '${data.teammateName}', role: ${data.role}, team: ${data.teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;

/**
 * Sleep utility for async delays
 * TypeScript: Promise-based delay
 * Python: time.sleep()
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send status update to parent
 * TypeScript: postMessage for worker communication
 * Python: Direct method call on TeammateManager
 */
function sendStatus(status: string): void {
    parentPort?.postMessage({
        type: "status_change",
        status,
        teammate: data.teammateName
    });
}

/**
 * Safe path resolution
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

/**
 * Read inbox from JSONL file
 */
async function readInbox(name: string): Promise<Message[]> {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);

    try {
        const content = await fs.readFile(inboxPath, "utf-8");
        const lines = content.trim().split("\n");
        const messages: Message[] = [];

        for (const line of lines) {
            if (line) {
                messages.push(JSON.parse(line));
            }
        }

        // Clear inbox after reading
        await fs.writeFile(inboxPath, "", "utf-8");

        return messages;
    } catch (error) {
        return [];
    }
}

/**
 * Send message via JSONL inbox
 */
async function sendMessage(
    to: string,
    content: string,
    msgType: string = "message",
    extra: Record<string, any> = {}
): Promise<string> {
    const msg: Message = {
        type: msgType,
        from: data.teammateName,
        content,
        timestamp: Date.now() / 1000,
        ...extra
    };

    const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
    const jsonLine = JSON.stringify(msg) + "\n";

    await fs.appendFile(inboxPath, jsonLine, "utf-8");
    return `Sent ${msgType} to ${to}`;
}

/**
 * Scan for unclaimed tasks
 * TypeScript: Async method with file filtering
 * Python: glob with list comprehension
 */
async function scanUnclaimedTasks(): Promise<Task[]> {
    try {
        await fs.mkdir(TASKS_DIR, { recursive: true });
        const files = await fs.readdir(TASKS_DIR);
        const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));
        const unclaimed: Task[] = [];

        for (const file of taskFiles) {
            const filePath = path.join(TASKS_DIR, file);
            const content = await fs.readFile(filePath, "utf-8");
            const task: Task = JSON.parse(content);

            if (
                task.status === "pending" &&
                !task.owner &&
                (!task.blockedBy || task.blockedBy.length === 0)
            ) {
                unclaimed.push(task);
            }
        }

        return unclaimed.sort((a, b) => a.id - b.id);
    } catch (error) {
        return [];
    }
}

/**
 * Claim a task by ID
 * TypeScript: Async method with atomic file operation
 * Python: Function with threading.Lock()
 */
async function claimTask(taskId: number, owner: string): Promise<string> {
    const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);

    try {
        const content = await fs.readFile(taskPath, "utf-8");
        const task: Task = JSON.parse(content);

        task.owner = owner;
        task.status = "in_progress";

        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

        return `Claimed task #${taskId} for ${owner}`;
    } catch (error) {
        return `Error: Task ${taskId} not found`;
    }
}

/**
 * Generate short request ID
 */
function generateRequestId(): string {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Create identity block for re-injection
 * TypeScript: Function returning message object
 * Python: Function returning dict
 */
function makeIdentityBlock(name: string, role: string, teamName: string): any {
    return {
        role: "user",
        content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
    };
}

/**
 * Execute tool and return result
 */
async function executeTool(toolName: string, args: any): Promise<string> {
    switch (toolName) {
        case "bash":
            return await runBash(args.command);
        case "read_file":
            return await runRead(args.path, args.limit);
        case "write_file":
            return await runWrite(args.path, args.content);
        case "edit_file":
            return await runEdit(args.path, args.old_text, args.new_text);
        case "send_message":
            return await sendMessage(args.to, args.content, args.msg_type || "message");
        case "read_inbox":
            const inbox = await readInbox(data.teammateName);
            return JSON.stringify(inbox, null, 2);
        case "shutdown_response":
            await sendMessage(
                "lead",
                args.reason || "",
                "shutdown_response",
                {
                    request_id: args.request_id,
                    approve: args.approve
                }
            );
            return `Shutdown ${args.approve ? "approved" : "rejected"}`;
        case "plan_approval":
            const requestId = generateRequestId();
            await sendMessage(
                "lead",
                args.plan || "",
                "plan_approval_response",
                {
                    request_id: requestId,
                    plan: args.plan
                }
            );
            return `Plan submitted (request_id=${requestId}). Waiting for lead approval.`;
        case "idle":
            return "Entering idle phase. Will poll for new tasks.";
        case "claim_task":
            return await claimTask(args.task_id, data.teammateName);
        default:
            return `Unknown tool: ${toolName}`;
    }
}

/**
 * Main autonomous agent loop
 * TypeScript: Async function with WORK and IDLE phases
 * Python: Synchronous function with WORK and IDLE phases
 */
async function autonomousLoop(): Promise<void> {
    const messages: any[] = [
        { role: "user", content: data.prompt }
    ];

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
            name: "send_message",
            description: "Send message to a teammate.",
            input_schema: {
                type: "object" as const,
                properties: {
                    to: { type: "string" },
                    content: { type: "string" },
                    msg_type: {
                        type: "string",
                        enum: ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const
                    }
                },
                required: ["to", "content"] as const
            }
        },
        {
            name: "read_inbox",
            description: "Read and drain your inbox.",
            input_schema: {
                type: "object" as const,
                properties: {}
            }
        },
        {
            name: "shutdown_response",
            description: "Respond to a shutdown request.",
            input_schema: {
                type: "object" as const,
                properties: {
                    request_id: { type: "string" },
                    approve: { type: "boolean" },
                    reason: { type: "string" }
                },
                required: ["request_id", "approve"] as const
            }
        },
        {
            name: "plan_approval",
            description: "Submit a plan for lead approval.",
            input_schema: {
                type: "object" as const,
                properties: {
                    plan: { type: "string" }
                },
                required: ["plan"] as const
            }
        },
        {
            name: "idle",
            description: "Signal that you have no more work. Enters idle polling phase.",
            input_schema: {
                type: "object" as const,
                properties: {}
            }
        },
        {
            name: "claim_task",
            description: "Claim a task from the task board by ID.",
            input_schema: {
                type: "object" as const,
                properties: {
                    task_id: { type: "integer" }
                },
                required: ["task_id"] as const
            }
        },
    ];

    // Main autonomous loop
    while (true) {
        // -- WORK PHASE: standard agent loop --
        let idleRequested = false;

        for (let i = 0; i < 50; i++) {
            // Check inbox for new messages
            const inbox = await readInbox(data.teammateName);
            for (const msg of inbox) {
                if (msg.type === "shutdown_request") {
                    sendStatus("shutdown");
                    return;
                }
                messages.push({
                    role: "user",
                    content: JSON.stringify(msg)
                });
            }

            try {
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
                    break;
                }

                const results: any[] = [];
                for (const block of response.content) {
                    if (block.type === "tool_use") {
                        let output: string;

                        if (block.name === "idle") {
                            idleRequested = true;
                            output = "Entering idle phase. Will poll for new tasks.";
                        } else {
                            output = await executeTool(block.name, block.input);
                        }

                        // Notify parent of tool usage
                        parentPort?.postMessage({
                            type: "tool_use",
                            teammate: data.teammateName,
                            tool: block.name,
                            output: String(output).substring(0, 200)
                        });

                        results.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: String(output),
                        });
                    }
                }

                messages.push({
                    role: "user",
                    content: results,
                });

                if (idleRequested) {
                    break;
                }
            } catch (error) {
                sendStatus("idle");
                return;
            }
        }

        // -- IDLE PHASE: poll for inbox messages and unclaimed tasks --
        sendStatus("idle");

        let resume = false;
        const polls = Math.floor(IDLE_TIMEOUT / (POLL_INTERVAL / 1000));

        for (let i = 0; i < polls; i++) {
            await sleep(POLL_INTERVAL);

            // Check inbox
            const inbox = await readInbox(data.teammateName);
            if (inbox.length > 0) {
                for (const msg of inbox) {
                    if (msg.type === "shutdown_request") {
                        sendStatus("shutdown");
                        return;
                    }
                    messages.push({
                        role: "user",
                        content: JSON.stringify(msg)
                    });
                }
                resume = true;
                break;
            }

            // Check for unclaimed tasks
            const unclaimed = await scanUnclaimedTasks();
            if (unclaimed.length > 0) {
                const task = unclaimed[0];
                await claimTask(task.id, data.teammateName);

                parentPort?.postMessage({
                    type: "task_claimed",
                    teammate: data.teammateName,
                    taskId: task.id
                });

                const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;

                // Re-inject identity if context is compressed
                if (messages.length <= 3) {
                    messages.unshift(makeIdentityBlock(data.teammateName, data.role, data.teamName));
                    messages.splice(1, 0, {
                        role: "assistant",
                        content: `I am ${data.teammateName}. Continuing.`
                    });
                }

                messages.push({ role: "user", content: taskPrompt });
                messages.push({
                    role: "assistant",
                    content: `Claimed task #${task.id}. Working on it.`
                });

                resume = true;
                break;
            }
        }

        if (!resume) {
            sendStatus("shutdown");
            return;
        }

        sendStatus("working");
    }
}

// Start the autonomous loop
autonomousLoop().catch((error) => {
    parentPort?.postMessage({
        type: "teammate_error",
        teammate: data.teammateName,
        error: error instanceof Error ? error.message : "Unknown error"
    });
});
