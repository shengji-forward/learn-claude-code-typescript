#!/usr/bin/env ts-node
// Harness: time -- the agent schedules its own future work.
// @ts-nocheck
// s14_cron_scheduler.ts - Cron / Scheduled Tasks
//
// The agent can schedule prompts for future execution using standard cron
// expressions. When a schedule matches the current time, it pushes a
// notification back into the main conversation loop.
//
//     Cron expression: 5 fields
//     +-------+-------+-------+-------+-------+
//     | min   | hour  | dom   | month | dow   |
//     | 0-59  | 0-23  | 1-31  | 1-12  | 0-6   |
//     +-------+-------+-------+-------+-------+
//     Examples:
//       "*/5 * * * *"   -> every 5 minutes
//       "0 9 * * 1"     -> Monday 9:00 AM
//       "30 14 * * *"   -> daily 2:30 PM
//
//     Two persistence modes:
//     +--------------------+-------------------------------+
//     | session-only       | In-memory list, lost on exit  |
//     | durable            | .claude/scheduled_tasks.json  |
//     +--------------------+-------------------------------+
//
//     Two trigger modes:
//     +--------------------+-------------------------------+
//     | recurring          | Repeats until deleted or      |
//     |                    |  7-day auto-expiry             |
//     | one-shot           | Fires once, then auto-deleted |
//     +--------------------+-------------------------------+
//
//     Jitter: recurring tasks can avoid exact minute boundaries.
//
//     Architecture:
//     +-------------------------------+
//     |  Background interval          |
//     |  (checks every 1 second)      |
//     |                               |
//     |  for each task:               |
//     |    if cronMatches(now):       |
//     |      enqueue notification     |
//     +-------------------------------+
//               |
//               v
//     [notification queue (array)]
//               |
//          (drained at top of agent_loop)
//               |
//               v
//     [injected as user messages before LLM call]
//
// Key idea: scheduling remembers future work, then hands it back to the
// same main loop when the time arrives.
//
// === TYPESCRIPT VS PYTHON ===
//
// 1. THREADING VS setInterval:
//    - Python: threading.Thread + threading.Event for background loop
//    - TypeScript: setInterval() with clearInterval() for cleanup
//    - Node.js is single-threaded; setInterval runs on the event loop
//
// 2. QUEUE:
//    - Python: queue.Queue with get_nowait() and Empty exception
//    - TypeScript: Simple array with push() and shift()
//    - No threading concerns in Node.js single-threaded model
//
// 3. FILE LOCKING:
//    - Python: PID-file with os.kill(pid, 0) for liveness check
//    - TypeScript: Same approach with process.kill(pid, 0)
//    - Both handle stale lock detection the same way
//
// 4. UUID:
//    - Python: uuid.uuid4().hex[:8]
//    - TypeScript: crypto.randomUUID().slice(0, 8)
//    - Both produce unique identifiers

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import crypto from "crypto";

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

const SCHEDULED_TASKS_FILE = path.join(WORKDIR, ".claude", "scheduled_tasks.json");
const CRON_LOCK_FILE = path.join(WORKDIR, ".claude", "cron.lock");
const AUTO_EXPIRY_DAYS = 7;
const JITTER_MINUTES = [0, 30]; // avoid these exact minutes for recurring tasks
const JITTER_OFFSET_MAX = 4;    // offset range in minutes

/**
 * CronLock - PID-file-based lock to prevent multiple sessions from
 * firing the same cron job.
 *
 * TypeScript: class with async file methods
 * Python: class CronLock with sync file methods
 */
class CronLock {
    private lockPath: string;

    constructor(lockPath?: string) {
        this.lockPath = lockPath || CRON_LOCK_FILE;
    }

    /**
     * Try to acquire the cron lock. Returns true on success.
     *
     * If a lock file exists, check whether the PID inside is still alive.
     * If the process is dead the lock is stale and we can take over.
     */
    async acquire(): Promise<boolean> {
        try {
            const content = await fs.readFile(this.lockPath, "utf-8");
            const storedPid = parseInt(content.trim(), 10);

            // PID liveness probe: send signal 0 (no-op) to check existence
            try {
                process.kill(storedPid, 0);
                // Process is alive -- lock is held by another session
                return false;
            } catch {
                // Stale lock (process dead or PID unparseable) -- fall through
            }
        } catch {
            // Lock file doesn't exist -- fall through
        }

        await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
        await fs.writeFile(this.lockPath, String(process.pid), "utf-8");
        return true;
    }

    /**
     * Remove the lock file if it belongs to this process.
     */
    async release(): Promise<void> {
        try {
            const content = await fs.readFile(this.lockPath, "utf-8");
            const storedPid = parseInt(content.trim(), 10);
            if (storedPid === process.pid) {
                await fs.unlink(this.lockPath);
            }
        } catch {
            // File doesn't exist or can't be read
        }
    }
}

/**
 * Check if a 5-field cron expression matches a given datetime.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: star (any), star/N (every N), N (exact), N-M (range), N,M (list)
 *
 * TypeScript: function with Date object
 * Python: function with datetime object
 */
function cronMatches(expr: string, dt: Date): boolean {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    // JavaScript Date: getDay() returns 0=Sunday; cron uses 0=Sunday. Match!
    // Python weekday() returns 0=Monday; needs conversion.
    const values = [
        dt.getMinutes(),
        dt.getHours(),
        dt.getDate(),
        dt.getMonth() + 1,  // JS months are 0-indexed
        dt.getDay(),        // JS days are 0=Sunday, same as cron
    ];
    const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

    for (let i = 0; i < 5; i++) {
        if (!_fieldMatches(fields[i], values[i], ranges[i][0], ranges[i][1])) {
            return false;
        }
    }
    return true;
}

/**
 * Match a single cron field against a value.
 *
 * TypeScript: function with string/number params
 * Python: def _field_matches(field: str, value: int, lo: int, hi: int) -> bool
 */
function _fieldMatches(field: string, value: number, lo: number, hi: number): boolean {
    if (field === "*") return true;

    for (const part of field.split(",")) {
        let step = 1;
        let partToCheck = part;

        // Handle step: */N or N-M/S
        if (part.includes("/")) {
            const slashIdx = part.indexOf("/");
            partToCheck = part.slice(0, slashIdx);
            step = parseInt(part.slice(slashIdx + 1), 10);
        }

        if (partToCheck === "*") {
            // */N -- check if value is on the step grid
            if ((value - lo) % step === 0) return true;
        } else if (partToCheck.includes("-")) {
            // Range: N-M
            const dashIdx = partToCheck.indexOf("-");
            const start = parseInt(partToCheck.slice(0, dashIdx), 10);
            const end = parseInt(partToCheck.slice(dashIdx + 1), 10);
            if (start <= value && value <= end && (value - start) % step === 0) {
                return true;
            }
        } else {
            // Exact value
            if (parseInt(partToCheck, 10) === value) return true;
        }
    }

    return false;
}

/**
 * Scheduled task interface
 */
interface ScheduledTask {
    id: string;
    cron: string;
    prompt: string;
    recurring: boolean;
    durable: boolean;
    createdAt: number;
    jitter_offset?: number;
    last_fired?: number;
}

/**
 * CronScheduler - Manage scheduled tasks with background checking.
 *
 * Teaching version keeps only the core pieces: schedule records, a
 * minute checker, optional persistence, and a notification queue.
 *
 * TypeScript: class with setInterval-based background checking
 * Python: class with threading.Thread for background loop
 *
 * Key differences:
 * - TypeScript uses setInterval instead of threading
 * - Notification queue is a simple array (no threading concerns)
 * - File I/O is async throughout
 */
class CronScheduler {
    tasks: ScheduledTask[] = [];
    notifications: string[] = [];     // simple array + push/shift
    private _intervalId: ReturnType<typeof setInterval> | null = null;
    private _lastCheckMinute = -1;    // avoid double-firing within same minute

    /**
     * Load durable tasks and start the background check interval.
     * TypeScript: setInterval returns a handle for cleanup
     * Python: threading.Thread(daemon=True).start()
     */
    async start(): Promise<void> {
        await this._loadDurable();
        this._intervalId = setInterval(() => this._checkLoop(), 1000);
        const count = this.tasks.length;
        if (count) {
            console.log(`[Cron] Loaded ${count} scheduled tasks`);
        }
    }

    /**
     * Stop the background interval.
     * TypeScript: clearInterval with the interval handle
     * Python: self._stop_event.set(); self._thread.join()
     */
    stop(): void {
        if (this._intervalId !== null) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
    }

    /**
     * Create a new scheduled task. Returns a status string.
     */
    create(
        cronExpr: string,
        prompt: string,
        recurring: boolean = true,
        durable: boolean = false
    ): string {
        const taskId = crypto.randomUUID().slice(0, 8);
        const now = Date.now() / 1000;

        const task: ScheduledTask = {
            id: taskId,
            cron: cronExpr,
            prompt,
            recurring,
            durable,
            createdAt: now,
        };

        // Jitter for recurring tasks: if the cron fires on :00 or :30,
        // note it so we can offset the check slightly
        if (recurring) {
            task.jitter_offset = this._computeJitter(cronExpr);
        }

        this.tasks.push(task);
        if (durable) {
            this._saveDurable();
        }

        const mode = recurring ? "recurring" : "one-shot";
        const store = durable ? "durable" : "session-only";
        return `Created task ${taskId} (${mode}, ${store}): cron=${cronExpr}`;
    }

    /**
     * Delete a scheduled task by ID.
     */
    delete(taskId: string): string {
        const before = this.tasks.length;
        this.tasks = this.tasks.filter((t) => t.id !== taskId);
        if (this.tasks.length < before) {
            this._saveDurable();
            return `Deleted task ${taskId}`;
        }
        return `Task ${taskId} not found`;
    }

    /**
     * List all scheduled tasks.
     */
    listTasks(): string {
        if (!this.tasks.length) return "No scheduled tasks.";
        const lines: string[] = [];
        for (const t of this.tasks) {
            const mode = t.recurring ? "recurring" : "one-shot";
            const store = t.durable ? "durable" : "session";
            const ageHours = (Date.now() / 1000 - t.createdAt) / 3600;
            lines.push(
                `  ${t.id}  ${t.cron}  [${mode}/${store}] ` +
                `(${ageHours.toFixed(1)}h old): ${t.prompt.slice(0, 60)}`
            );
        }
        return lines.join("\n");
    }

    /**
     * Drain all pending notifications from the queue.
     * TypeScript: Array with shift() (FIFO)
     * Python: queue.Queue with get_nowait() and Empty exception
     */
    drainNotifications(): string[] {
        const notifications: string[] = [];
        while (this.notifications.length > 0) {
            notifications.push(this.notifications.shift()!);
        }
        return notifications;
    }

    /**
     * If cron targets :00 or :30, return a small offset (1-4 minutes).
     */
    private _computeJitter(cronExpr: string): number {
        const fields = cronExpr.trim().split(/\s+/);
        if (fields.length < 1) return 0;
        const minuteField = fields[0];
        const minuteVal = parseInt(minuteField, 10);
        if (!isNaN(minuteVal) && JITTER_MINUTES.includes(minuteVal)) {
            // Deterministic jitter based on the expression hash
            const hash = cronExpr.split("").reduce((acc, char) => {
                return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
            }, 0);
            return (Math.abs(hash) % JITTER_OFFSET_MAX) + 1;
        }
        return 0;
    }

    /**
     * Background check: check every second if any task is due.
     * TypeScript: called by setInterval, runs on the event loop
     * Python: runs in a background thread
     */
    private _checkLoop(): void {
        const now = new Date();
        const currentMinute = now.getHours() * 60 + now.getMinutes();

        // Only check once per minute to avoid double-firing
        if (currentMinute !== this._lastCheckMinute) {
            this._lastCheckMinute = currentMinute;
            this._checkTasks(now);
        }
    }

    /**
     * Check all tasks against current time, fire matches.
     */
    private _checkTasks(now: Date): void {
        const expired: string[] = [];
        const firedOneshots: string[] = [];

        for (const task of this.tasks) {
            // Auto-expiry: recurring tasks older than 7 days
            const ageDays = (Date.now() / 1000 - task.createdAt) / 86400;
            if (task.recurring && ageDays > AUTO_EXPIRY_DAYS) {
                expired.push(task.id);
                continue;
            }

            // Apply jitter offset for the match check
            let checkTime = now;
            const jitter = task.jitter_offset || 0;
            if (jitter) {
                checkTime = new Date(now.getTime() - jitter * 60000);
            }

            if (cronMatches(task.cron, checkTime)) {
                const notification =
                    `[Scheduled task ${task.id}]: ${task.prompt}`;
                this.notifications.push(notification);
                task.last_fired = Date.now() / 1000;
                console.log(`[Cron] Fired: ${task.id}`);

                if (!task.recurring) {
                    firedOneshots.push(task.id);
                }
            }
        }

        // Clean up expired and one-shot tasks
        if (expired.length || firedOneshots.length) {
            const removeIds = new Set([...expired, ...firedOneshots]);
            this.tasks = this.tasks.filter((t) => !removeIds.has(t.id));
            for (const tid of expired) {
                console.log(`[Cron] Auto-expired: ${tid} (older than ${AUTO_EXPIRY_DAYS} days)`);
            }
            for (const tid of firedOneshots) {
                console.log(`[Cron] One-shot completed and removed: ${tid}`);
            }
            this._saveDurable();
        }
    }

    /**
     * Load durable tasks from .claude/scheduled_tasks.json.
     */
    private async _loadDurable(): Promise<void> {
        try {
            const data = JSON.parse(await fs.readFile(SCHEDULED_TASKS_FILE, "utf-8"));
            // Only load durable tasks
            this.tasks = data.filter((t: any) => t.durable);
        } catch {
            // File doesn't exist or can't be parsed
        }
    }

    /**
     * Save durable tasks to disk.
     */
    private _saveDurable(): void {
        const durable = this.tasks.filter((t) => t.durable);
        const dir = path.dirname(SCHEDULED_TASKS_FILE);
        fs.mkdir(dir, { recursive: true })
            .then(() => fs.writeFile(
                SCHEDULED_TASKS_FILE,
                JSON.stringify(durable, null, 2) + "\n",
                "utf-8"
            ))
            .catch((error) => {
                console.error(`[Cron] Error saving tasks: ${error}`);
            });
    }

    /**
     * On startup, check each durable task's last_fired time.
     *
     * If a task should have fired while the session was closed (i.e.
     * the gap between last_fired and now contains at least one cron match),
     * flag it as missed. The caller can then let the user decide whether
     * to run or discard each missed task.
     */
    detectMissedTasks(): { id: string; cron: string; prompt: string; missed_at: string }[] {
        const now = new Date();
        const missed: { id: string; cron: string; prompt: string; missed_at: string }[] = [];

        for (const task of this.tasks) {
            if (task.last_fired === undefined || task.last_fired === null) continue;

            const lastDt = new Date(task.last_fired * 1000);
            // Walk forward minute-by-minute from last_fired to now (cap at 24h)
            const check = new Date(lastDt.getTime() + 60000);
            const cap = new Date(Math.min(now.getTime(), lastDt.getTime() + 24 * 3600000));

            while (check <= cap) {
                if (cronMatches(task.cron, check)) {
                    missed.push({
                        id: task.id,
                        cron: task.cron,
                        prompt: task.prompt,
                        missed_at: check.toISOString(),
                    });
                    break; // one miss is enough to flag it
                }
                check.setTime(check.getTime() + 60000);
            }
        }
        return missed;
    }
}

// Global scheduler
const scheduler = new CronScheduler();

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
 * THE DISPATCH MAP: Includes cron tools
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

    cron_create: async (input) => {
        const cronExpr = input.cron as string;
        const prompt = input.prompt as string;
        const recurring = (input.recurring ?? true) as boolean;
        const durable = (input.durable ?? false) as boolean;
        return scheduler.create(cronExpr, prompt, recurring, durable);
    },

    cron_delete: async (input) => {
        const id = input.id as string;
        return scheduler.delete(id);
    },

    cron_list: async () => {
        return scheduler.listTasks();
    },
};

/**
 * Tool definitions for Anthropic API -- includes cron tools
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
        name: "cron_create",
        description: "Schedule a recurring or one-shot task with a cron expression.",
        input_schema: {
            type: "object" as const,
            properties: {
                cron: {
                    type: "string",
                    description: "5-field cron expression: 'min hour dom month dow'",
                },
                prompt: {
                    type: "string",
                    description: "The prompt to inject when the task fires",
                },
                recurring: {
                    type: "boolean",
                    description: "true=repeat, false=fire once then delete. Default true.",
                },
                durable: {
                    type: "boolean",
                    description: "true=persist to disk, false=session-only. Default false.",
                },
            },
            required: ["cron", "prompt"] as const,
        },
    },
    {
        name: "cron_delete",
        description: "Delete a scheduled task by ID.",
        input_schema: {
            type: "object" as const,
            properties: {
                id: {
                    type: "string",
                    description: "Task ID to delete",
                },
            },
            required: ["id"] as const,
        },
    },
    {
        name: "cron_list",
        description: "List all scheduled tasks.",
        input_schema: {
            type: "object" as const,
            properties: {},
        },
    },
];

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.\n\nYou can schedule future work with cron_create. Tasks fire automatically and their prompts are injected into the conversation.`;

/**
 * Cron-aware agent loop.
 *
 * Before each LLM call, drain the notification queue and inject any
 * fired task prompts as user messages. This is how the agent "wakes up"
 * to handle scheduled work.
 *
 * TypeScript: async function with array-based notification draining
 * Python: def agent_loop(messages: list)
 */
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        // Drain scheduled task notifications
        const notifications = scheduler.drainNotifications();
        for (const note of notifications) {
            console.log(`[Cron notification] ${note.slice(0, 100)}`);
            messages.push({ role: "user", content: note });
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
    }
}

/**
 * Main REPL loop
 */
async function main(): Promise<void> {
    await scheduler.start();
    console.log("[Cron scheduler running. Background checks every second.]");
    console.log("[Commands: /cron to list tasks, /test to fire a test notification]");

    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Extra: Cron Scheduler. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms14 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                scheduler.stop();
                break;
            }

            if (query.trim() === "/cron") {
                console.log(scheduler.listTasks());
                continue;
            }

            if (query.trim() === "/test") {
                // Manually enqueue a test notification for demonstration
                scheduler.notifications.push("[Scheduled task test-0000]: This is a test notification.");
                console.log("[Test notification enqueued. It will be injected on your next message.]");
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
                scheduler.stop();
                break;
            }
            console.error("Error:", error);
        }
    }

    rl.close();
}

main().catch((error) => {
    console.error("Fatal error:", error);
    scheduler.stop();
    process.exit(1);
});
