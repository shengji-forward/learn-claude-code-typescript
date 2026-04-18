#!/usr/bin/env ts-node
// Harness: self-organization -- idle polling and automatic task claiming.
// @ts-nocheck
/**
 * s11_autonomous_agents.ts - Autonomous Agents
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on s10's protocols.
 *
 *     Teammate lifecycle:
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> shutdown
 *
 *     Identity re-injection after compression:
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * Key insight: "The agent finds work itself."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. IDLE POLLING:
 *    - Python: time.sleep(POLL_INTERVAL) in loop
 *    - TypeScript: await sleep(POLL_INTERVAL * 1000) with async/await
 *    - TypeScript: Sleep returns Promise for non-blocking delay
 *
 * 2. TASK SCANNING:
 *    - Python: glob("task_*.json") with pathlib
 *    - TypeScript: fs.readdir() with filter function
 *    - TypeScript: Parse JSON and filter with async operations
 *
 * 3. FILE LOCKING:
 *    - Python: threading.Lock() for claim_task
 *    - TypeScript: exclusive-create lockfile (fs.open 'wx') protects claim
 *    - TypeScript: each claim must serialize read -> check -> write
 *
 * 4. WORKER LIFECYCLE:
 *    - Python: Daemon threads with while True loop
 *    - TypeScript: Worker with async/await pattern
 *    - TypeScript: Explicit worker termination on shutdown
 *
 * 5. IDENTITY RE-INJECTION:
 *    - Python: Insert identity block at start of messages list
 *    - TypeScript: Array.unshift() to prepend identity
 *    - TypeScript: Type-safe message array manipulation
 *
 * 6. TASK CLAIMING:
 *    - Python: Read file, update dict, write back with lock
 *    - TypeScript: Lockfile-protected read-modify-write
 *    - TypeScript: two workers cannot both observe an unclaimed task
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { existsSync, promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import { Worker } from "worker_threads";
import { randomUUID } from "crypto";

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
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const POLL_INTERVAL = 5;  // seconds
const IDLE_TIMEOUT = 60;  // seconds

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

const execAsync = promisify(exec);

/**
 * Valid message types
 * TypeScript: Readonly array for compile-time safety
 * Python: Set of strings
 */
const VALID_MSG_TYPES = [
    "message",
    "broadcast",
    "shutdown_request",
    "shutdown_response",
    "plan_approval_response",
] as const;

type MessageType = typeof VALID_MSG_TYPES[number];

/**
 * Teammate status enum
 * TypeScript: enum for compile-time type safety
 * Python: String literals
 */
enum TeammateStatus {
    IDLE = "idle",
    WORKING = "working",
    SHUTDOWN = "shutdown",
}

/**
 * Request status enum for protocol tracking
 * TypeScript: enum for compile-time safety
 * Python: String literals
 */
enum RequestStatus {
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
}

/**
 * Task status enum
 * TypeScript: enum for compile-time safety
 * Python: String literals
 */
enum TaskStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Task interface
 * TypeScript: Interface defining task structure
 * Python: Dict with keys
 */
interface Task {
    id: number;
    subject: string;
    description: string;
    status: TaskStatus;
    owner?: string;
    blockedBy?: string[];
}

/**
 * Protocol request interface
 */
interface ProtocolRequest {
    requestId: string;
    type: "shutdown" | "plan_approval";
    target?: string;
    from?: string;
    plan?: string;
    status: RequestStatus;
    timestamp: number;
}

/**
 * Teammate member interface
 */
interface TeammateMember {
    name: string;
    role: string;
    status: TeammateStatus;
}

/**
 * Team config interface
 */
interface TeamConfig {
    team_name: string;
    members: TeammateMember[];
}

/**
 * Message interface
 */
interface TeamMessage {
    type: MessageType;
    from: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

/**
 * Sleep utility for async delays
 * TypeScript: Promise-based delay
 * Python: time.sleep()
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * MessageBus: JSONL inbox per teammate
 * TypeScript: Class with async file operations
 * Python: Class with synchronous file operations
 */
class MessageBus {
    private dir: string;

    constructor(inboxDir: string) {
        this.dir = inboxDir;
    }

    /**
     * Initialize inbox directory
     * TypeScript: Async method
     * Python: Synchronous mkdir in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
    }

    /**
     * Send message to teammate
     * TypeScript: Async method with type validation
     * Python: Synchronous method
     */
    async send(
        sender: string,
        to: string,
        content: string,
        msgType: MessageType = "message",
        extra: Record<string, any> = {}
    ): Promise<string> {
        if (!VALID_MSG_TYPES.includes(msgType)) {
            return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
        }

        const msg: TeamMessage = {
            type: msgType,
            from: sender,
            content,
            timestamp: Date.now() / 1000,
            ...extra
        };

        const inboxPath = path.join(this.dir, `${to}.jsonl`);
        const jsonLine = JSON.stringify(msg) + "\n";

        await fs.appendFile(inboxPath, jsonLine, "utf-8");
        return `Sent ${msgType} to ${to}`;
    }

    /**
     * Read and drain inbox
     * TypeScript: Async method returning Promise
     * Python: Synchronous method returning list
     */
    async readInbox(name: string): Promise<TeamMessage[]> {
        const inboxPath = path.join(this.dir, `${name}.jsonl`);

        try {
            const content = await fs.readFile(inboxPath, "utf-8");
            const lines = content.trim().split("\n");
            const messages: TeamMessage[] = [];

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
     * Broadcast message to all teammates except sender
     * TypeScript: Async method with array iteration
     * Python: Synchronous method
     */
    async broadcast(sender: string, content: string, teammates: string[]): Promise<string> {
        let count = 0;
        for (const name of teammates) {
            if (name !== sender) {
                await this.send(sender, name, content, "broadcast");
                count++;
            }
        }
        return `Broadcast to ${count} teammates`;
    }
}

// Initialize message bus
const BUS = new MessageBus(INBOX_DIR);

/**
 * ProtocolManager: Track and manage protocol requests
 * TypeScript: Class with encapsulated state
 * Python: Global dicts with threading.Lock()
 */
class ProtocolManager {
    private shutdownRequests: Map<string, ProtocolRequest> = new Map();
    private planRequests: Map<string, ProtocolRequest> = new Map();

    createShutdownRequest(target: string): string {
        const requestId = randomUUID().substring(0, 8);
        this.shutdownRequests.set(requestId, {
            requestId,
            type: "shutdown",
            target,
            status: RequestStatus.PENDING,
            timestamp: Date.now() / 1000,
        });
        return requestId;
    }

    createPlanRequest(from: string, plan: string): string {
        const requestId = randomUUID().substring(0, 8);
        this.planRequests.set(requestId, {
            requestId,
            type: "plan_approval",
            from,
            plan,
            status: RequestStatus.PENDING,
            timestamp: Date.now() / 1000,
        });
        return requestId;
    }

    updateShutdownStatus(requestId: string, approved: boolean): void {
        const request = this.shutdownRequests.get(requestId);
        if (request) {
            request.status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;
        }
    }

    updatePlanStatus(requestId: string, approved: boolean): void {
        const request = this.planRequests.get(requestId);
        if (request) {
            request.status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;
        }
    }

    getShutdownRequest(requestId: string): ProtocolRequest | undefined {
        return this.shutdownRequests.get(requestId);
    }

    getPlanRequest(requestId: string): ProtocolRequest | undefined {
        return this.planRequests.get(requestId);
    }
}

// Initialize protocol manager
const PROTOCOLS = new ProtocolManager();

/**
 * TaskManager: Scan and claim tasks from .tasks/ directory
 * TypeScript: Class with async file operations
 * Python: Module-level functions with sync file operations
 */
class TaskManager {
    private tasksDir: string;

    constructor(tasksDir: string) {
        this.tasksDir = tasksDir;
    }

    /**
     * Initialize tasks directory
     * TypeScript: Async method
     * Python: TASKS_DIR.mkdir(exist_ok=True)
     */
    async init(): Promise<void> {
        await fs.mkdir(this.tasksDir, { recursive: true });
    }

    /**
     * Scan for unclaimed tasks
     * TypeScript: Async method with file filtering
     * Python: glob with list comprehension
     */
    async scanUnclaimedTasks(): Promise<Task[]> {
        await fs.mkdir(this.tasksDir, { recursive: true });

        try {
            const files = await fs.readdir(this.tasksDir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));
            const unclaimed: Task[] = [];

            for (const file of taskFiles) {
                const filePath = path.join(this.tasksDir, file);
                const content = await fs.readFile(filePath, "utf-8");
                const task: Task = JSON.parse(content);

                if (
                    task.status === TaskStatus.PENDING &&
                    !task.owner &&
                    (!task.blockedBy || task.blockedBy.length === 0)
                ) {
                    unclaimed.push(task);
                }
            }

            // Sort by task ID
            return unclaimed.sort((a, b) => a.id - b.id);
        } catch (error) {
            return [];
        }
    }

    /**
     * Claim a task by ID.
     *
     * The check-status-and-update must be atomic so two workers cannot both
     * think a task is unclaimed and both write their own ownership. We use
     * exclusive lockfile creation (O_EXCL via fs.open with 'wx') as the
     * cross-thread / cross-process equivalent of Python's threading.Lock().
     */
    async claimTask(taskId: number, owner: string): Promise<string> {
        const taskPath = path.join(this.tasksDir, `task_${taskId}.json`);
        const lockPath = path.join(this.tasksDir, ".claim.lock");

        const acquireLock = async (): Promise<void> => {
            let staleDeadline = Date.now() + 5000;
            while (true) {
                try {
                    const fh = await fs.open(lockPath, "wx");
                    await fh.close();
                    return;
                } catch (err: any) {
                    if (err?.code !== "EEXIST") throw err;
                    if (Date.now() > staleDeadline) {
                        try { await fs.unlink(lockPath); } catch {}
                        staleDeadline = Date.now() + 5000;
                    }
                    await sleep(20);
                }
            }
        };

        await acquireLock();
        try {
            const content = await fs.readFile(taskPath, "utf-8");
            const task: Task = JSON.parse(content);

            if (task.owner) {
                return `Error: Task ${taskId} has already been claimed by ${task.owner}`;
            }
            if (task.status !== TaskStatus.PENDING) {
                return `Error: Task ${taskId} cannot be claimed because its status is '${task.status}'`;
            }
            if (task.blockedBy && task.blockedBy.length > 0) {
                return `Error: Task ${taskId} is blocked by other task(s) and cannot be claimed yet`;
            }

            task.owner = owner;
            task.status = TaskStatus.IN_PROGRESS;

            await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

            return `Claimed task #${taskId} for ${owner}`;
        } catch (error) {
            return `Error: Task ${taskId} not found`;
        } finally {
            try { await fs.unlink(lockPath); } catch {}
        }
    }

    /**
     * List all tasks with status markers
     * TypeScript: Async method
     * Python: Loop with print statements
     */
    async listTasks(): Promise<string> {
        await fs.mkdir(this.tasksDir, { recursive: true });

        try {
            const files = await fs.readdir(this.tasksDir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

            if (taskFiles.length === 0) {
                return "No tasks found.";
            }

            const lines: string[] = [];

            for (const file of taskFiles) {
                const filePath = path.join(this.tasksDir, file);
                const content = await fs.readFile(filePath, "utf-8");
                const task: Task = JSON.parse(content);

                const marker = {
                    [TaskStatus.PENDING]: "[ ]",
                    [TaskStatus.IN_PROGRESS]: "[>]",
                    [TaskStatus.COMPLETED]: "[x]",
                }[task.status] || "[?]";

                const owner = task.owner ? ` @${task.owner}` : "";
                lines.push(`  ${marker} #${task.id}: ${task.subject}${owner}`);
            }

            return lines.join("\n");
        } catch (error) {
            return "Error reading tasks.";
        }
    }
}

// Initialize task manager
const TASKS = new TaskManager(TASKS_DIR);

/**
 * TeammateManager: persistent named agents with autonomous behavior
 * TypeScript: Class with Worker management
 * Python: Class with threading.Thread management
 */
class TeammateManager {
    private dir: string;
    private configPath: string;
    private config: TeamConfig;
    private workers: Map<string, Worker> = new Map();

    constructor(teamDir: string) {
        this.dir = teamDir;
        this.configPath = path.join(teamDir, "config.json");
        this.config = { team_name: "default", members: [] };
    }

    /**
     * Initialize manager
     * TypeScript: Async initialization pattern
     * Python: Can do all initialization in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        await this.loadConfig();
        await BUS.init();
    }

    /**
     * Load config from file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async loadConfig(): Promise<void> {
        try {
            const content = await fs.readFile(this.configPath, "utf-8");
            this.config = JSON.parse(content);
        } catch (error) {
            // Use default config if file doesn't exist
            this.config = { team_name: "default", members: [] };
        }
    }

    /**
     * Save config to file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async saveConfig(): Promise<void> {
        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.config, null, 2),
            "utf-8"
        );
    }

    /**
     * Find member by name
     * TypeScript: Method returning member or undefined
     * Python: Method returning member or None
     */
    private findMember(name: string): TeammateMember | undefined {
        return this.config.members.find(m => m.name === name);
    }

    /**
     * Set member status
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async setStatus(name: string, status: TeammateStatus): Promise<void> {
        const member = this.findMember(name);
        if (member) {
            member.status = status;
            await this.saveConfig();
        }
    }

    /**
     * Spawn a new autonomous teammate
     * TypeScript: Creates Worker, returns immediately
     * Python: Creates Thread, returns immediately
     */
    async spawn(name: string, role: string, prompt: string): Promise<string> {
        const member = this.findMember(name);

        if (member) {
            if (member.status !== TeammateStatus.IDLE && member.status !== TeammateStatus.SHUTDOWN) {
                return `Error: '${name}' is currently ${member.status}`;
            }
            member.status = TeammateStatus.WORKING;
            member.role = role;
        } else {
            const newMember: TeammateMember = {
                name,
                role,
                status: TeammateStatus.WORKING
            };
            this.config.members.push(newMember);
        }

        await this.saveConfig();

        // Create worker for autonomous teammate
        const jsWorkerPath = path.join(__dirname, "autonomous-worker.js");
        const tsWorkerPath = path.join(__dirname, "autonomous-worker.ts");
        const workerPath = existsSync(jsWorkerPath) ? jsWorkerPath : tsWorkerPath;
        const worker = new Worker(workerPath, {
            workerData: {
                teammateName: name,
                role,
                prompt,
                teamName: this.config.team_name,
                workdir: WORKDIR,
                inboxDir: INBOX_DIR,
                tasksDir: TASKS_DIR,
                modelId: MODEL,
                apiBase: process.env.ANTHROPIC_BASE_URL,
                pollInterval: POLL_INTERVAL,
                idleTimeout: IDLE_TIMEOUT,
            },
            ...(workerPath.endsWith(".ts")
                ? { execArgv: ["--loader", "ts-node/esm"] }
                : {}),
        });

        // Handle worker messages
        worker.on("message", async (msg: any) => {
            if (msg.type === "status_change") {
                await this.setStatus(name, msg.status as TeammateStatus);
                if (msg.status === TeammateStatus.SHUTDOWN) {
                    this.workers.delete(name);
                }
            } else if (msg.type === "tool_use") {
                console.log(`  [${msg.teammate}] ${msg.tool}: ${msg.output}`);
            } else if (msg.type === "task_claimed") {
                console.log(`  [${name}] Auto-claimed task #${msg.taskId}`);
            }
        });

        worker.on("error", async (error) => {
            console.error(`  [${name}] Worker error: ${error.message}`);
            await this.setStatus(name, TeammateStatus.IDLE);
            this.workers.delete(name);
        });

        worker.on("exit", async (code) => {
            if (code !== 0) {
                const m = this.findMember(name);
                if (m && m.status === TeammateStatus.WORKING) {
                    await this.setStatus(name, TeammateStatus.IDLE);
                }
            }
            this.workers.delete(name);
        });

        this.workers.set(name, worker);

        return `Spawned autonomous '${name}' (role: ${role})`;
    }

    /**
     * List all teammates
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listAll(): Promise<string> {
        if (this.config.members.length === 0) {
            return "No teammates.";
        }

        const lines: string[] = [`Team: ${this.config.team_name}`];
        for (const m of this.config.members) {
            lines.push(`  ${m.name} (${m.role}): ${m.status}`);
        }
        return lines.join("\n");
    }

    /**
     * Get all member names
     * TypeScript: Method returning string array
     * Python: Method returning list
     */
    memberNames(): string[] {
        return this.config.members.map(m => m.name);
    }

    /**
     * Terminate all workers
     * TypeScript: Explicit cleanup required
     * Python: Daemon threads auto-clean
     */
    terminateAll(): void {
        for (const [name, worker] of Array.from(this.workers.entries())) {
            worker.terminate();
            this.workers.delete(name);
        }
    }
}

// Initialize teammate manager
const TEAMMATES = new TeammateManager(TEAM_DIR);

// -- Base tool implementations --
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
 * Handle shutdown request (lead side)
 */
async function handleShutdownRequest(teammate: string): Promise<string> {
    const requestId = PROTOCOLS.createShutdownRequest(teammate);
    await BUS.send(
        "lead",
        teammate,
        "Please shut down gracefully.",
        "shutdown_request",
        { request_id: requestId }
    );
    return `Shutdown request ${requestId} sent to '${teammate}'`;
}

/**
 * Handle plan review (lead side)
 */
async function handlePlanReview(
    requestId: string,
    approve: boolean,
    feedback: string = ""
): Promise<string> {
    const request = PROTOCOLS.getPlanRequest(requestId);
    if (!request) {
        return `Error: Unknown plan request_id '${requestId}'`;
    }

    PROTOCOLS.updatePlanStatus(requestId, approve);
    await BUS.send(
        "lead",
        request.from || "",
        feedback,
        "plan_approval_response",
        {
            request_id: requestId,
            approve: approve,
            feedback: feedback
        }
    );

    return `Plan ${approve ? "approved" : "rejected"} for '${request.from}'`;
}

/**
 * Check shutdown status (lead side)
 */
function checkShutdownStatus(requestId: string): string {
    const request = PROTOCOLS.getShutdownRequest(requestId);
    if (!request) {
        return JSON.stringify({ error: "not found" });
    }
    return JSON.stringify({
        request_id: request.requestId,
        target: request.target,
        status: request.status,
    });
}

// Type for tool handler functions
type ToolHandler = (input: any) => Promise<string> | string;

/**
 * Tool handlers map
 * TypeScript: Type-safe object with handler functions
 * Python: Dict with lambda functions
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => await runBash(input.command),
    read_file: async (input) => await runRead(input.path, input.limit),
    write_file: async (input) => await runWrite(input.path, input.content),
    edit_file: async (input) => await runEdit(input.path, input.old_text, input.new_text),
    spawn_teammate: async (input) => await TEAMMATES.spawn(input.name, input.role, input.prompt),
    list_teammates: async () => await TEAMMATES.listAll(),
    send_message: async (input) => await BUS.send(
        "lead",
        input.to,
        input.content,
        input.msg_type || "message"
    ),
    read_inbox: async () => {
        const inbox = await BUS.readInbox("lead");
        return JSON.stringify(inbox, null, 2);
    },
    broadcast: async (input) => await BUS.broadcast(
        "lead",
        input.content,
        TEAMMATES.memberNames()
    ),
    shutdown_request: async (input) => await handleShutdownRequest(input.teammate),
    shutdown_response: (input) => checkShutdownStatus(input.request_id),
    plan_approval: async (input) => await handlePlanReview(
        input.request_id,
        input.approve,
        input.feedback || ""
    ),
    idle: () => "Lead does not idle.",
    claim_task: async (input) => await TASKS.claimTask(input.task_id, "lead"),
};

/**
 * Tool definitions for the API
 * TypeScript: Array of tool definitions
 * Python: List of tool definition dicts
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
        name: "spawn_teammate",
        description: "Spawn an autonomous teammate.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" },
                role: { type: "string" },
                prompt: { type: "string" }
            },
            required: ["name", "role", "prompt"] as const
        }
    },
    {
        name: "list_teammates",
        description: "List all teammates.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "send_message",
        description: "Send a message to a teammate.",
        input_schema: {
            type: "object" as const,
            properties: {
                to: { type: "string" },
                content: { type: "string" },
                msg_type: {
                    type: "string",
                    enum: VALID_MSG_TYPES
                }
            },
            required: ["to", "content"] as const
        }
    },
    {
        name: "read_inbox",
        description: "Read and drain the lead's inbox.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "broadcast",
        description: "Send a message to all teammates.",
        input_schema: {
            type: "object" as const,
            properties: {
                content: { type: "string" }
            },
            required: ["content"] as const
        }
    },
    {
        name: "shutdown_request",
        description: "Request a teammate to shut down.",
        input_schema: {
            type: "object" as const,
            properties: {
                teammate: { type: "string" }
            },
            required: ["teammate"] as const
        }
    },
    {
        name: "shutdown_response",
        description: "Check shutdown request status.",
        input_schema: {
            type: "object" as const,
            properties: {
                request_id: { type: "string" }
            },
            required: ["request_id"] as const
        }
    },
    {
        name: "plan_approval",
        description: "Approve or reject a teammate's plan.",
        input_schema: {
            type: "object" as const,
            properties: {
                request_id: { type: "string" },
                approve: { type: "boolean" },
                feedback: { type: "string" }
            },
            required: ["request_id", "approve"] as const
        }
    },
    {
        name: "idle",
        description: "Enter idle state (for lead -- rarely used).",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "claim_task",
        description: "Claim a task from the board by ID.",
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
 * Agent loop with inbox checking
 * TypeScript: Async function with inbox processing
 * Python: Synchronous function with inbox processing
 */
async function agentLoop(messages: any[]): Promise<void> {
    while (true) {
        // Check for inbox messages
        const inbox = await BUS.readInbox("lead");
        if (inbox.length > 0) {
            messages.push({
                role: "user",
                content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
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

                    console.log(`> ${block.name}:`);
                    console.log(String(output).substring(0, 200));

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
 */
async function main(): Promise<void> {
    await TEAMMATES.init();
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

    console.log("\nSession 11: Autonomous Agents");
    console.log("Idle cycle with task board polling and auto-claiming.\n");

    try {
        while (true) {
            const query = await question("\x1b[36ms11 >> \x1b[0m");

            if (query.trim().toLowerCase() === "q" || query.trim() === "exit" || query.trim() === "") {
                break;
            }

            if (query.trim() === "/team") {
                console.log(await TEAMMATES.listAll());
                continue;
            }

            if (query.trim() === "/inbox") {
                const inbox = await BUS.readInbox("lead");
                console.log(JSON.stringify(inbox, null, 2));
                continue;
            }

            if (query.trim() === "/tasks") {
                console.log(await TASKS.listTasks());
                continue;
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
        TEAMMATES.terminateAll();
        rl.close();
    }
}

// Run the main function
main().catch(console.error);
