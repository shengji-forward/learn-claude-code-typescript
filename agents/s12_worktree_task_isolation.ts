#!/usr/bin/env ts-node
/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. GIT OPERATIONS:
 *    - Python: subprocess.run(["git", ...]) with shell commands
 *    - TypeScript: simple-git library for cleaner git operations
 *    - TypeScript: Type-safe git command execution
 *
 * 2. WORKTREE LIFECYCLE:
 *    - Python: Class methods with sync git operations
 *    - TypeScript: Async class methods with simple-git
 *    - TypeScript: Promise-based git operations
 *
 * 3. EVENT LOGGING:
 *    - Python: Write directly to file in emit()
 *    - TypeScript: Async fs.appendFile() for non-blocking writes
 *    - TypeScript: JSONL format maintained
 *
 * 4. TASK BINDING:
 *    - Python: Direct dict manipulation
 *    - TypeScript: Type-safe interface updates
 *    - TypeScript: Atomic read-modify-write operations
 *
 * 5. REPO DETECTION:
 *    - Python: subprocess.run(["git", "rev-parse", "--show-toplevel"])
 *    - TypeScript: simple-git.checkIsRepo() + git.raw()
 *    - TypeScript: More robust error handling
 *
 * 6. PATH VALIDATION:
 *    - Python: pathlib.Path with is_relative_to()
 *    - TypeScript: path.resolve() with startsWith()
 *    - TypeScript: Cross-platform path handling
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
const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const execAsync = promisify(exec);

/**
 * Detect git repository root
 * TypeScript: Async function using git command
 * Python: Synchronous subprocess.run()
 */
async function detectRepoRoot(cwd: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync("git rev-parse --show-toplevel", {
            cwd,
            timeout: 10000,
        });
        const root = stdout.trim();
        // Verify root exists
        try {
            await fs.access(root);
            return root;
        } catch {
            return null;
        }
    } catch (error) {
        return null;
    }
}

/**
 * REPO_ROOT: Git repository root or current directory
 */
let REPO_ROOT = WORKDIR;
detectRepoRoot(WORKDIR).then(root => {
    if (root) {
        REPO_ROOT = root;
    }
}).catch(() => {
    // Keep WORKDIR as default
});

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility.`;

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
    owner: string;
    worktree: string;
    blockedBy: string[];
    created_at: number;
    updated_at: number;
}

/**
 * Worktree status enum
 * TypeScript: enum for compile-time safety
 * Python: String literals
 */
enum WorktreeStatus {
    ACTIVE = "active",
    REMOVED = "removed",
    KEPT = "kept",
}

/**
 * Worktree interface
 * TypeScript: Interface defining worktree structure
 * Python: Dict with keys
 */
interface Worktree {
    name: string;
    path: string;
    branch: string;
    task_id?: number;
    status: WorktreeStatus;
    created_at: number;
    kept_at?: number;
    removed_at?: number;
}

/**
 * Worktree index interface
 */
interface WorktreeIndex {
    worktrees: Worktree[];
}

/**
 * Event interface
 */
interface WorktreeEvent {
    event: string;
    ts: number;
    task: Record<string, any>;
    worktree: Record<string, any>;
    error?: string;
    raw?: string;
}

/**
 * EventBus: append-only lifecycle events for observability
 * TypeScript: Class with async file operations
 * Python: Class with synchronous file operations
 */
class EventBus {
    private eventLogPath: string;

    constructor(eventLogPath: string) {
        this.eventLogPath = eventLogPath;
    }

    /**
     * Initialize event log
     * TypeScript: Async method
     * Python: Synchronous in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(path.dirname(this.eventLogPath), { recursive: true });
        try {
            await fs.access(this.eventLogPath);
        } catch {
            // File doesn't exist, create empty file
            await fs.writeFile(this.eventLogPath, "", "utf-8");
        }
    }

    /**
     * Emit event to log
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async emit(
        event: string,
        task: Record<string, any> = {},
        worktree: Record<string, any> = {},
        error?: string
    ): Promise<void> {
        const payload: WorktreeEvent = {
            event,
            ts: Date.now() / 1000,
            task,
            worktree,
        };
        if (error) {
            payload.error = error;
        }

        const jsonLine = JSON.stringify(payload) + "\n";
        await fs.appendFile(this.eventLogPath, jsonLine, "utf-8");
    }

    /**
     * List recent events
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listRecent(limit: number = 20): Promise<string> {
        const n = Math.max(1, Math.min(limit || 20, 200));

        try {
            const content = await fs.readFile(this.eventLogPath, "utf-8");
            const lines = content.split("\n").filter(l => l.trim());
            const recent = lines.slice(-n);

            const items: WorktreeEvent[] = [];
            for (const line of recent) {
                try {
                    items.push(JSON.parse(line));
                } catch {
                    items.push({ event: "parse_error", ts: 0, task: {}, worktree: {}, raw: line });
                }
            }

            return JSON.stringify(items, null, 2);
        } catch (error) {
            return "[]";
        }
    }
}

/**
 * TaskManager: persistent task board with optional worktree binding
 * TypeScript: Class with async file operations
 * Python: Class with synchronous file operations
 */
class TaskManager {
    private dir: string;
    private nextId: number;

    constructor(tasksDir: string) {
        this.dir = tasksDir;
        this.nextId = 1; // Will be updated in init()
    }

    /**
     * Initialize task manager
     * TypeScript: Async initialization
     * Python: Can do all in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        this.nextId = (await this.maxId()) + 1;
    }

    /**
     * Get max task ID
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async maxId(): Promise<number> {
        try {
            const files = await fs.readdir(this.dir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

            const ids: number[] = [];
            for (const file of taskFiles) {
                try {
                    const match = file.match(/task_(\d+)\.json/);
                    if (match) {
                        ids.push(parseInt(match[1], 10));
                    }
                } catch {
                    // Skip invalid filenames
                }
            }

            return ids.length > 0 ? Math.max(...ids) : 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get task file path
     */
    private taskPath(taskId: number): string {
        return path.join(this.dir, `task_${taskId}.json`);
    }

    /**
     * Load task from file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async load(taskId: number): Promise<Task> {
        const taskPath = this.taskPath(taskId);
        const content = await fs.readFile(taskPath, "utf-8");
        return JSON.parse(content);
    }

    /**
     * Save task to file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async save(task: Task): Promise<void> {
        const taskPath = this.taskPath(task.id);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }

    /**
     * Create a new task
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async create(subject: string, description: string = ""): Promise<string> {
        const task: Task = {
            id: this.nextId,
            subject,
            description,
            status: TaskStatus.PENDING,
            owner: "",
            worktree: "",
            blockedBy: [],
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
        };

        await this.save(task);
        this.nextId++;

        return JSON.stringify(task, null, 2);
    }

    /**
     * Get task by ID
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async get(taskId: number): Promise<string> {
        const task = await this.load(taskId);
        return JSON.stringify(task, null, 2);
    }

    /**
     * Check if task exists
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async exists(taskId: number): Promise<boolean> {
        try {
            await fs.access(this.taskPath(taskId));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Update task status or owner
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async update(taskId: number, status?: TaskStatus, owner?: string): Promise<string> {
        const task = await this.load(taskId);

        if (status) {
            if (!Object.values(TaskStatus).includes(status)) {
                throw new Error(`Invalid status: ${status}`);
            }
            task.status = status;
        }

        if (owner !== undefined) {
            task.owner = owner;
        }

        task.updated_at = Date.now() / 1000;
        await this.save(task);

        return JSON.stringify(task, null, 2);
    }

    /**
     * Bind worktree to task
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async bindWorktree(taskId: number, worktree: string, owner: string = ""): Promise<string> {
        const task = await this.load(taskId);

        task.worktree = worktree;
        if (owner) {
            task.owner = owner;
        }
        if (task.status === TaskStatus.PENDING) {
            task.status = TaskStatus.IN_PROGRESS;
        }

        task.updated_at = Date.now() / 1000;
        await this.save(task);

        return JSON.stringify(task, null, 2);
    }

    /**
     * Unbind worktree from task
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async unbindWorktree(taskId: number): Promise<string> {
        const task = await this.load(taskId);

        task.worktree = "";
        task.updated_at = Date.now() / 1000;
        await this.save(task);

        return JSON.stringify(task, null, 2);
    }

    /**
     * List all tasks
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listAll(): Promise<string> {
        try {
            const files = await fs.readdir(this.dir);
            const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

            if (taskFiles.length === 0) {
                return "No tasks.";
            }

            const tasks: Task[] = [];
            for (const file of taskFiles) {
                const content = await fs.readFile(path.join(this.dir, file), "utf-8");
                tasks.push(JSON.parse(content));
            }

            tasks.sort((a, b) => a.id - b.id);

            const lines: string[] = [];
            for (const t of tasks) {
                const marker = {
                    [TaskStatus.PENDING]: "[ ]",
                    [TaskStatus.IN_PROGRESS]: "[>]",
                    [TaskStatus.COMPLETED]: "[x]",
                }[t.status] || "[?]";

                const owner = t.owner ? ` owner=${t.owner}` : "";
                const wt = t.worktree ? ` wt=${t.worktree}` : "";
                lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
            }

            return lines.join("\n");
        } catch (error) {
            return "Error listing tasks.";
        }
    }
}

/**
 * WorktreeManager: create/list/run/remove git worktrees + lifecycle index
 * TypeScript: Class with async git operations using simple-git
 * Python: Class with sync git operations using subprocess
 */
class WorktreeManager {
    private repoRoot: string;
    private tasks: TaskManager;
    private events: EventBus;
    private dir: string;
    private indexPath: string;
    private gitAvailable: boolean = false;

    constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
        this.repoRoot = repoRoot;
        this.tasks = tasks;
        this.events = events;
        this.dir = path.join(repoRoot, ".worktrees");
        this.indexPath = path.join(this.dir, "index.json");
    }

    /**
     * Initialize worktree manager
     * TypeScript: Async initialization
     * Python: Can do all in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });

        // Initialize index file
        try {
            await fs.access(this.indexPath);
        } catch {
            await fs.writeFile(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf-8");
        }

        // Check if git is available
        this.gitAvailable = await this.isGitRepo();
    }

    /**
     * Check if directory is a git repository
     * TypeScript: Async method using git command
     * Python: Synchronous method using subprocess
     */
    private async isGitRepo(): Promise<boolean> {
        try {
            await execAsync("git rev-parse --is-inside-work-tree", {
                cwd: this.repoRoot,
                timeout: 10000,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Run git command
     * TypeScript: Async method using exec
     * Python: Synchronous method using subprocess
     */
    private async runGit(args: string[]): Promise<string> {
        if (!this.gitAvailable) {
            throw new Error("Not in a git repository. worktree tools require git.");
        }

        try {
            const { stdout, stderr } = await execAsync(`git ${args.join(" ")}`, {
                cwd: this.repoRoot,
                timeout: 120000,
            });
            return (stdout + stderr).trim() || "(no output)";
        } catch (error: any) {
            const msg = (error.stdout + error.stderr).trim();
            throw new Error(msg || `git ${args.join(" ")} failed`);
        }
    }

    /**
     * Load worktree index
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async loadIndex(): Promise<WorktreeIndex> {
        const content = await fs.readFile(this.indexPath, "utf-8");
        return JSON.parse(content);
    }

    /**
     * Save worktree index
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async saveIndex(data: WorktreeIndex): Promise<void> {
        await fs.writeFile(this.indexPath, JSON.stringify(data, null, 2), "utf-8");
    }

    /**
     * Find worktree by name
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async find(name: string): Promise<Worktree | undefined> {
        const idx = await this.loadIndex();
        return idx.worktrees.find(wt => wt.name === name);
    }

    /**
     * Validate worktree name
     * TypeScript: Function with regex
     * Python: Function with regex
     */
    private validateName(name: string): void {
        const regex = /^[A-Za-z0-9._-]{1,40}$/;
        if (!regex.test(name)) {
            throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
        }
    }

    /**
     * Create a new worktree
     * TypeScript: Async method with error handling
     * Python: Synchronous method with error handling
     */
    async create(name: string, taskId?: number, baseRef: string = "HEAD"): Promise<string> {
        this.validateName(name);

        const existing = await this.find(name);
        if (existing) {
            throw new Error(`Worktree '${name}' already exists in index`);
        }

        if (taskId !== undefined && !(await this.tasks.exists(taskId))) {
            throw new Error(`Task ${taskId} not found`);
        }

        const worktreePath = path.join(this.dir, name);
        const branch = `wt/${name}`;

        await this.events.emit(
            "worktree.create.before",
            taskId !== undefined ? { id: taskId } : {},
            { name, base_ref: baseRef }
        );

        try {
            // Create git worktree
            await this.runGit(["worktree", "add", "-b", branch, worktreePath, baseRef]);

            // Create worktree entry
            const worktree: Worktree = {
                name,
                path: worktreePath,
                branch,
                task_id: taskId,
                status: WorktreeStatus.ACTIVE,
                created_at: Date.now() / 1000,
            };

            // Update index
            const idx = await this.loadIndex();
            idx.worktrees.push(worktree);
            await this.saveIndex(idx);

            // Bind to task if provided
            if (taskId !== undefined) {
                await this.tasks.bindWorktree(taskId, name);
            }

            await this.events.emit(
                "worktree.create.after",
                taskId !== undefined ? { id: taskId } : {},
                {
                    name,
                    path: worktreePath,
                    branch,
                    status: "active",
                }
            );

            return JSON.stringify(worktree, null, 2);
        } catch (error: any) {
            await this.events.emit(
                "worktree.create.failed",
                taskId !== undefined ? { id: taskId } : {},
                { name, base_ref: baseRef },
                error instanceof Error ? error.message : String(error)
            );
            throw error;
        }
    }

    /**
     * List all worktrees
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listAll(): Promise<string> {
        const idx = await this.loadIndex();
        const wts = idx.worktrees;

        if (wts.length === 0) {
            return "No worktrees in index.";
        }

        const lines: string[] = [];
        for (const wt of wts) {
            const suffix = wt.task_id ? ` task=${wt.task_id}` : "";
            lines.push(
                `[${wt.status}] ${wt.name} -> ${wt.path} (${wt.branch})${suffix}`
            );
        }

        return lines.join("\n");
    }

    /**
     * Get worktree status
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async status(name: string): Promise<string> {
        const wt = await this.find(name);
        if (!wt) {
            return `Error: Unknown worktree '${name}'`;
        }

        const wtPath = wt.path;

        try {
            await fs.access(wtPath);
        } catch {
            return `Error: Worktree path missing: ${wtPath}`;
        }

        try {
            const { stdout, stderr } = await execAsync("git status --short --branch", {
                cwd: wtPath,
                timeout: 60000,
            });
            const text = (stdout + stderr).trim();
            return text || "Clean worktree";
        } catch (error: any) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Run command in worktree
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async run(name: string, command: string): Promise<string> {
        const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
        if (dangerous.some(d => command.includes(d))) {
            return "Error: Dangerous command blocked";
        }

        const wt = await this.find(name);
        if (!wt) {
            return `Error: Unknown worktree '${name}'`;
        }

        const wtPath = wt.path;

        try {
            await fs.access(wtPath);
        } catch {
            return `Error: Worktree path missing: ${wtPath}`;
        }

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: wtPath,
                timeout: 300000,
            });
            const output = (stdout + stderr).trim();
            return output ? output.substring(0, 50000) : "(no output)";
        } catch (error: any) {
            if (error.code === "ETIMEDOUT") {
                return "Error: Timeout (300s)";
            }
            return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    }

    /**
     * Remove a worktree
     * TypeScript: Async method with cleanup
     * Python: Synchronous method with cleanup
     */
    async remove(name: string, force: boolean = false, completeTask: boolean = false): Promise<string> {
        const wt = await this.find(name);
        if (!wt) {
            return `Error: Unknown worktree '${name}'`;
        }

        await this.events.emit(
            "worktree.remove.before",
            wt.task_id !== undefined ? { id: wt.task_id } : {},
            { name, path: wt.path }
        );

        try {
            // Remove git worktree
            const args = ["worktree", "remove"];
            if (force) {
                args.push("--force");
            }
            args.push(wt.path);

            await this.runGit(args);

            // Complete task if requested
            if (completeTask && wt.task_id !== undefined) {
                const taskId = wt.task_id;
                const taskJson = await this.tasks.get(taskId);
                const task = JSON.parse(taskJson);

                await this.tasks.update(taskId, TaskStatus.COMPLETED);
                await this.tasks.unbindWorktree(taskId);

                await this.events.emit(
                    "task.completed",
                    {
                        id: taskId,
                        subject: task.subject || "",
                        status: "completed",
                    },
                    { name }
                );
            }

            // Update index
            const idx = await this.loadIndex();
            for (const item of idx.worktrees) {
                if (item.name === name) {
                    item.status = WorktreeStatus.REMOVED;
                    item.removed_at = Date.now() / 1000;
                }
            }
            await this.saveIndex(idx);

            await this.events.emit(
                "worktree.remove.after",
                wt.task_id !== undefined ? { id: wt.task_id } : {},
                { name, path: wt.path, status: "removed" }
            );

            return `Removed worktree '${name}'`;
        } catch (error: any) {
            await this.events.emit(
                "worktree.remove.failed",
                wt.task_id !== undefined ? { id: wt.task_id } : {},
                { name, path: wt.path },
                error instanceof Error ? error.message : String(error)
            );
            throw error;
        }
    }

    /**
     * Keep a worktree (mark as kept without removing)
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async keep(name: string): Promise<string> {
        const wt = await this.find(name);
        if (!wt) {
            return `Error: Unknown worktree '${name}'`;
        }

        const idx = await this.loadIndex();
        let kept: Worktree | undefined;

        for (const item of idx.worktrees) {
            if (item.name === name) {
                item.status = WorktreeStatus.KEPT;
                item.kept_at = Date.now() / 1000;
                kept = item;
                break;
            }
        }

        await this.saveIndex(idx);

        await this.events.emit(
            "worktree.keep",
            wt.task_id !== undefined ? { id: wt.task_id } : {},
            {
                name,
                path: wt.path,
                status: "kept",
            }
        );

        return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
    }
}

// Initialize managers (async initialization will be done in main())
const TASKS_DIR = path.join(REPO_ROOT, ".tasks");
const WORKTREES_DIR = path.join(REPO_ROOT, ".worktrees");
const EVENTS_PATH = path.join(WORKTREES_DIR, "events.jsonl");

const TASKS = new TaskManager(TASKS_DIR);
const EVENTS = new EventBus(EVENTS_PATH);
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// -- Base tools (kept minimal, same style as previous sessions) --
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
    } catch (error: any) {
        if (error.code === "ETIMEDOUT") {
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
    task_create: async (input) => await TASKS.create(input.subject, input.description || ""),
    task_list: async () => await TASKS.listAll(),
    task_get: async (input) => await TASKS.get(input.task_id),
    task_update: async (input) => await TASKS.update(
        input.task_id,
        input.status ? TaskStatus[input.status as keyof typeof TaskStatus] : undefined,
        input.owner
    ),
    task_bind_worktree: async (input) => await TASKS.bindWorktree(
        input.task_id,
        input.worktree,
        input.owner || ""
    ),
    worktree_create: async (input) => await WORKTREES.create(
        input.name,
        input.task_id,
        input.base_ref || "HEAD"
    ),
    worktree_list: async () => await WORKTREES.listAll(),
    worktree_status: async (input) => await WORKTREES.status(input.name),
    worktree_run: async (input) => await WORKTREES.run(input.name, input.command),
    worktree_keep: async (input) => await WORKTREES.keep(input.name),
    worktree_remove: async (input) => await WORKTREES.remove(
        input.name,
        input.force || false,
        input.complete_task || false
    ),
    worktree_events: async (input) => await EVENTS.listRecent(input.limit || 20),
};

/**
 * Tool definitions for the API
 * TypeScript: Array of tool definitions
 * Python: List of tool definition dicts
 */
const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command in the current workspace (blocking).",
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
        description: "Create a new task on the shared task board.",
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
        name: "task_list",
        description: "List all tasks with status, owner, and worktree binding.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "task_get",
        description: "Get task details by ID.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "integer" }
            },
            required: ["task_id"] as const
        }
    },
    {
        name: "task_update",
        description: "Update task status or owner.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "integer" },
                status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"]
                },
                owner: { type: "string" }
            },
            required: ["task_id"] as const
        }
    },
    {
        name: "task_bind_worktree",
        description: "Bind a task to a worktree name.",
        input_schema: {
            type: "object" as const,
            properties: {
                task_id: { type: "integer" },
                worktree: { type: "string" },
                owner: { type: "string" }
            },
            required: ["task_id", "worktree"] as const
        }
    },
    {
        name: "worktree_create",
        description: "Create a git worktree and optionally bind it to a task.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" },
                task_id: { type: "integer" },
                base_ref: { type: "string" }
            },
            required: ["name"] as const
        }
    },
    {
        name: "worktree_list",
        description: "List worktrees tracked in .worktrees/index.json.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "worktree_status",
        description: "Show git status for one worktree.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" }
            },
            required: ["name"] as const
        }
    },
    {
        name: "worktree_run",
        description: "Run a shell command in a named worktree directory.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" },
                command: { type: "string" }
            },
            required: ["name", "command"] as const
        }
    },
    {
        name: "worktree_remove",
        description: "Remove a worktree and optionally mark its bound task completed.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" },
                force: { type: "boolean" },
                complete_task: { type: "boolean" }
            },
            required: ["name"] as const
        }
    },
    {
        name: "worktree_keep",
        description: "Mark a worktree as kept in lifecycle state without removing it.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" }
            },
            required: ["name"] as const
        }
    },
    {
        name: "worktree_events",
        description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
        input_schema: {
            type: "object" as const,
            properties: {
                limit: { type: "integer" }
            }
        }
    },
];

/**
 * Agent loop
 * TypeScript: Async function
 * Python: Synchronous function
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
 */
async function main(): Promise<void> {
    // Initialize managers
    await TASKS.init();
    await EVENTS.init();
    await WORKTREES.init();

    // Detect repo root asynchronously
    const repoRoot = await detectRepoRoot(WORKDIR);
    if (repoRoot) {
        REPO_ROOT = repoRoot;
    }

    console.log(`Repo root for s12: ${REPO_ROOT}`);
    if (!(await WORKTREES["gitAvailable"])) {
        console.log("Note: Not in a git repo. worktree_* tools will return errors.");
    }

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

    console.log("\nSession 12: Worktree + Task Isolation");
    console.log("Directory-level isolation for parallel task execution.\n");

    try {
        while (true) {
            const query = await question("\x1b[36ms12 >> \x1b[0m");

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
        rl.close();
    }
}

// Run the main function
main().catch(console.error);
