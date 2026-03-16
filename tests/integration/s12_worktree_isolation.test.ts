/**
 * s12_worktree_isolation.test.ts - Integration tests for Session 12
 *
 * Tests for:
 * - Worktree creation (with and without task binding)
 * - Command execution in worktree isolation
 * - Task-worktree binding and coordination
 * - Worktree removal and task completion
 *
 * === TEST COVERAGE ===
 *
 * Python project has NO tests, so these are the first tests for s12.
 * Focus on worktree lifecycle and task coordination.
 * Note: Git operations are mocked for test reliability.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Task status enum
 */
enum TaskStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Task interface
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
 */
enum WorktreeStatus {
    ACTIVE = "active",
    REMOVED = "removed",
    KEPT = "kept",
}

/**
 * Worktree interface
 */
interface Worktree {
    name: string;
    path: string;
    branch: string;
    task_id?: number;
    status: WorktreeStatus;
    created_at: number;
    removed_at?: number;
    kept_at?: number;
}

/**
 * Worktree index interface
 */
interface WorktreeIndex {
    worktrees: Worktree[];
}

/**
 * EventBus for lifecycle logging
 */
class EventBus {
    private logPath: string;

    constructor(logPath: string) {
        this.logPath = logPath;
    }

    async init(): Promise<void> {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    }

    async emit(
        event: string,
        primary: Record<string, any>,
        context: Record<string, any>,
        error?: string
    ): Promise<void> {
        const entry = {
            event,
            primary,
            context,
            error,
            timestamp: Date.now() / 1000,
        };
        const line = JSON.stringify(entry) + "\n";
        await fs.appendFile(this.logPath, line, "utf-8");
    }
}

/**
 * TaskManager for worktree coordination
 */
class TaskManager {
    private tasksDir: string;

    constructor(tasksDir: string) {
        this.tasksDir = tasksDir;
    }

    async init(): Promise<void> {
        await fs.mkdir(this.tasksDir, { recursive: true });
    }

    async create(id: number, subject: string, description: string, owner: string): Promise<Task> {
        const task: Task = {
            id,
            subject,
            description,
            status: TaskStatus.PENDING,
            owner,
            worktree: "",
            blockedBy: [],
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
        };
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
        return task;
    }

    async get(id: number): Promise<string> {
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        return await fs.readFile(taskPath, "utf-8");
    }

    async update(id: number, status: TaskStatus): Promise<void> {
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        const content = await fs.readFile(taskPath, "utf-8");
        const task: Task = JSON.parse(content);
        task.status = status;
        task.updated_at = Date.now() / 1000;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }

    async bindWorktree(id: number, worktree: string): Promise<void> {
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        const content = await fs.readFile(taskPath, "utf-8");
        const task: Task = JSON.parse(content);
        task.worktree = worktree;
        task.updated_at = Date.now() / 1000;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }

    async unbindWorktree(id: number): Promise<void> {
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        const content = await fs.readFile(taskPath, "utf-8");
        const task: Task = JSON.parse(content);
        task.worktree = "";
        task.updated_at = Date.now() / 1000;
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }

    async exists(id: number): Promise<boolean> {
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        try {
            await fs.access(taskPath);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * WorktreeManager (simplified for testing without git)
 */
class WorktreeManager {
    private repoRoot: string;
    private tasks: TaskManager;
    private events: EventBus;
    private dir: string;
    private indexPath: string;

    constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
        this.repoRoot = repoRoot;
        this.tasks = tasks;
        this.events = events;
        this.dir = path.join(repoRoot, ".worktrees");
        this.indexPath = path.join(this.dir, "index.json");
    }

    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });

        // Initialize index file
        try {
            await fs.access(this.indexPath);
        } catch {
            await fs.writeFile(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf-8");
        }
    }

    private async loadIndex(): Promise<WorktreeIndex> {
        const content = await fs.readFile(this.indexPath, "utf-8");
        return JSON.parse(content);
    }

    private async saveIndex(data: WorktreeIndex): Promise<void> {
        await fs.writeFile(this.indexPath, JSON.stringify(data, null, 2), "utf-8");
    }

    private async find(name: string): Promise<Worktree | undefined> {
        const idx = await this.loadIndex();
        return idx.worktrees.find(wt => wt.name === name);
    }

    private validateName(name: string): void {
        const regex = /^[A-Za-z0-9._-]{1,40}$/;
        if (!regex.test(name)) {
            throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
        }
    }

    /**
     * Create a new worktree (without actual git operations for testing)
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
            // Create worktree directory (without git for testing)
            await fs.mkdir(worktreePath, { recursive: true });

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
     */
    async listAll(): Promise<string> {
        const idx = await this.loadIndex();
        const wts = idx.worktrees;

        if (wts.length === 0) {
            return "No worktrees in index.";
        }

        const lines: string[] = [];
        for (const wt of wts) {
            const taskInfo = wt.task_id !== undefined ? ` [task #${wt.task_id}]` : "";
            lines.push(`  ${wt.name}: ${wt.branch}${taskInfo} (${wt.status})`);
        }
        return lines.join("\n");
    }

    /**
     * Get worktree status
     */
    async status(name: string): Promise<string> {
        const wt = await this.find(name);
        if (!wt) {
            return `Error: Unknown worktree '${name}'`;
        }

        const taskInfo = wt.task_id !== undefined ? `Task: #${wt.task_id}` : "Task: (none)";
        return `Worktree: ${wt.name}\nBranch: ${wt.branch}\nPath: ${wt.path}\nStatus: ${wt.status}\n${taskInfo}\nCreated: ${new Date(wt.created_at * 1000).toISOString()}`;
    }

    /**
     * Run command in worktree
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
            // Remove worktree directory
            await fs.rm(wt.path, { recursive: true, force: true });

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

describe("Session 12: Worktree Isolation", () => {
    const TEST_DIR = path.join(process.cwd(), ".test-s12");
    const TASKS_DIR = path.join(TEST_DIR, ".tasks");
    const EVENT_LOG = path.join(TEST_DIR, ".worktrees", "events.jsonl");
    let taskManager: TaskManager;
    let eventBus: EventBus;
    let worktreeManager: WorktreeManager;

    beforeEach(async () => {
        // Setup: clean test environment
        await fs.mkdir(TEST_DIR, { recursive: true });
        taskManager = new TaskManager(TASKS_DIR);
        await taskManager.init();
        eventBus = new EventBus(EVENT_LOG);
        await eventBus.init();
        worktreeManager = new WorktreeManager(TEST_DIR, taskManager, eventBus);
        await worktreeManager.init();
    });

    afterEach(async () => {
        // Cleanup: remove test directory
        try {
            await fs.rm(TEST_DIR, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe("Worktree Creation", () => {
        it("should create worktree with valid name", async () => {
            const result = await worktreeManager.create("feature-1");
            const worktree = JSON.parse(result);

            expect(worktree.name).toBe("feature-1");
            expect(worktree.status).toBe(WorktreeStatus.ACTIVE);
            expect(worktree.branch).toBe("wt/feature-1");
        });

        it("should create worktree directory on filesystem", async () => {
            await worktreeManager.create("feature-1");
            const worktreePath = path.join(TEST_DIR, ".worktrees", "feature-1");

            await expect(fs.access(worktreePath)).resolves.toBeUndefined();
        });

        it("should reject invalid worktree names", async () => {
            await expect(worktreeManager.create("invalid name!")).rejects.toThrow();
        });

        it("should reject worktree name that is too long", async () => {
            const longName = "a".repeat(41);
            await expect(worktreeManager.create(longName)).rejects.toThrow();
        });

        it("should accept valid worktree names with special chars", async () => {
            const validNames = ["feature-1", "feature_2", "feature.3", "feature-4.test"];

            for (const name of validNames) {
                const result = await worktreeManager.create(name);
                const worktree = JSON.parse(result);
                expect(worktree.name).toBe(name);
            }
        });

        it("should reject duplicate worktree names", async () => {
            await worktreeManager.create("feature-1");
            await expect(worktreeManager.create("feature-1")).rejects.toThrow("already exists");
        });

        it("should emit creation events", async () => {
            await worktreeManager.create("feature-1");

            const logContent = await fs.readFile(EVENT_LOG, "utf-8");
            const events = logContent.trim().split("\n").map(line => JSON.parse(line));

            expect(events.length).toBeGreaterThanOrEqual(2);
            expect(events[0].event).toBe("worktree.create.before");
            expect(events[1].event).toBe("worktree.create.after");
        });
    });

    describe("Task-Worktree Binding", () => {
        it("should bind worktree to task", async () => {
            await taskManager.create(1, "Task 1", "Description", "owner");
            await worktreeManager.create("feature-1", 1);

            const taskJson = await taskManager.get(1);
            const task = JSON.parse(taskJson);

            expect(task.worktree).toBe("feature-1");
        });

        it("should store task_id in worktree", async () => {
            await taskManager.create(1, "Task 1", "Description", "owner");
            const result = await worktreeManager.create("feature-1", 1);
            const worktree = JSON.parse(result);

            expect(worktree.task_id).toBe(1);
        });

        it("should reject worktree creation for non-existent task", async () => {
            await expect(worktreeManager.create("feature-1", 999)).rejects.toThrow("Task 999 not found");
        });

        it("should show task information in worktree status", async () => {
            await taskManager.create(1, "Task 1", "Description", "owner");
            await worktreeManager.create("feature-1", 1);

            const status = await worktreeManager.status("feature-1");

            expect(status).toContain("Task: #1");
        });
    });

    describe("Command Execution in Worktree", () => {
        beforeEach(async () => {
            await worktreeManager.create("feature-1");
        });

        it("should run command in worktree directory", async () => {
            const result = await worktreeManager.run("feature-1", "echo 'test'");
            expect(result.trim()).toBe("test");
        });

        it("should run command that creates files", async () => {
            await worktreeManager.run("feature-1", "echo 'content' > test.txt");
            const testPath = path.join(TEST_DIR, ".worktrees", "feature-1", "test.txt");

            const content = await fs.readFile(testPath, "utf-8");
            expect(content.trim()).toBe("content");
        });

        it("should block dangerous commands", async () => {
            const result = await worktreeManager.run("feature-1", "rm -rf /");
            expect(result).toContain("Dangerous command blocked");
        });

        it("should reject commands for non-existent worktree", async () => {
            const result = await worktreeManager.run("non-existent", "echo test");
            expect(result).toContain("Unknown worktree");
        });

        it("should return error for missing worktree path", async () => {
            // Create worktree entry but remove directory
            await worktreeManager.create("feature-2");
            await fs.rm(path.join(TEST_DIR, ".worktrees", "feature-2"), { recursive: true });

            const result = await worktreeManager.run("feature-2", "echo test");
            expect(result).toContain("Worktree path missing");
        });
    });

    describe("Worktree Removal", () => {
        beforeEach(async () => {
            await worktreeManager.create("feature-1");
        });

        it("should remove worktree and mark as removed", async () => {
            const result = await worktreeManager.remove("feature-1");

            expect(result).toContain("Removed worktree 'feature-1'");

            const status = await worktreeManager.status("feature-1");
            expect(status).toContain("removed");
        });

        it("should remove worktree directory", async () => {
            await worktreeManager.remove("feature-1");
            const worktreePath = path.join(TEST_DIR, ".worktrees", "feature-1");

            await expect(fs.access(worktreePath)).rejects.toThrow();
        });

        it("should emit removal events", async () => {
            await worktreeManager.remove("feature-1");

            const logContent = await fs.readFile(EVENT_LOG, "utf-8");
            const events = logContent.trim().split("\n").map(line => JSON.parse(line));

            const removeEvents = events.filter(e => e.event.includes("remove"));
            expect(removeEvents.length).toBeGreaterThanOrEqual(2);
        });

        it("should reject removal of non-existent worktree", async () => {
            const result = await worktreeManager.remove("non-existent");
            expect(result).toContain("Unknown worktree");
        });
    });

    describe("Worktree Removal with Task Completion", () => {
        beforeEach(async () => {
            await taskManager.create(1, "Task 1", "Description", "owner");
            await worktreeManager.create("feature-1", 1);
        });

        it("should complete task when removing with completeTask=true", async () => {
            await worktreeManager.remove("feature-1", false, true);

            const taskJson = await taskManager.get(1);
            const task = JSON.parse(taskJson);

            expect(task.status).toBe(TaskStatus.COMPLETED);
        });

        it("should unbind worktree from task on completion", async () => {
            await worktreeManager.remove("feature-1", false, true);

            const taskJson = await taskManager.get(1);
            const task = JSON.parse(taskJson);

            expect(task.worktree).toBe("");
        });

        it("should emit task completion event", async () => {
            await worktreeManager.remove("feature-1", false, true);

            const logContent = await fs.readFile(EVENT_LOG, "utf-8");
            const events = logContent.trim().split("\n").map(line => JSON.parse(line));

            const completionEvent = events.find(e => e.event === "task.completed");
            expect(completionEvent).toBeDefined();
            expect(completionEvent?.primary.id).toBe(1);
        });

        it("should not complete task when completeTask=false", async () => {
            await worktreeManager.remove("feature-1", false, false);

            const taskJson = await taskManager.get(1);
            const task = JSON.parse(taskJson);

            expect(task.status).not.toBe(TaskStatus.COMPLETED);
        });
    });

    describe("Worktree Listing", () => {
        it("should return empty message when no worktrees", async () => {
            const result = await worktreeManager.listAll();
            expect(result).toBe("No worktrees in index.");
        });

        it("should list all worktrees", async () => {
            await worktreeManager.create("feature-1");
            await worktreeManager.create("feature-2");

            const result = await worktreeManager.listAll();

            expect(result).toContain("feature-1");
            expect(result).toContain("feature-2");
        });

        it("should show task association in list", async () => {
            await taskManager.create(1, "Task 1", "Description", "owner");
            await worktreeManager.create("feature-1", 1);

            const result = await worktreeManager.listAll();

            expect(result).toContain("[task #1]");
        });
    });

    describe("Worktree Keep", () => {
        it("should mark worktree as kept", async () => {
            await worktreeManager.create("feature-1");
            const result = await worktreeManager.keep("feature-1");
            const worktree = JSON.parse(result);

            expect(worktree.status).toBe(WorktreeStatus.KEPT);
        });

        it("should set kept_at timestamp", async () => {
            await worktreeManager.create("feature-1");
            await worktreeManager.keep("feature-1");

            const status = await worktreeManager.status("feature-1");
            expect(status).toContain("kept");
        });

        it("should emit keep event", async () => {
            await worktreeManager.create("feature-1");
            await worktreeManager.keep("feature-1");

            const logContent = await fs.readFile(EVENT_LOG, "utf-8");
            const events = logContent.trim().split("\n").map(line => JSON.parse(line));

            const keepEvent = events.find(e => e.event === "worktree.keep");
            expect(keepEvent).toBeDefined();
        });
    });

    describe("Integration Workflows", () => {
        it("should handle complete task-worktree lifecycle", async () => {
            // Create task
            await taskManager.create(1, "Implement feature", "Description", "developer");

            // Create worktree bound to task
            await worktreeManager.create("feature-1", 1);

            // Verify binding
            let taskJson = await taskManager.get(1);
            let task = JSON.parse(taskJson);
            expect(task.worktree).toBe("feature-1");

            // Execute work in worktree
            await worktreeManager.run("feature-1", "echo 'work completed' > work.txt");

            // Complete work and remove worktree
            await worktreeManager.remove("feature-1", false, true);

            // Verify task completed
            taskJson = await taskManager.get(1);
            task = JSON.parse(taskJson);
            expect(task.status).toBe(TaskStatus.COMPLETED);
            expect(task.worktree).toBe("");
        });

        it("should handle multiple concurrent worktrees", async () => {
            await taskManager.create(1, "Task 1", "Description", "dev1");
            await taskManager.create(2, "Task 2", "Description", "dev2");

            await worktreeManager.create("feature-1", 1);
            await worktreeManager.create("feature-2", 2);

            // Work in first worktree
            await worktreeManager.run("feature-1", "echo 'work 1' > work1.txt");

            // Work in second worktree (isolated)
            await worktreeManager.run("feature-2", "echo 'work 2' > work2.txt");

            // Verify isolation - worktree 1 should not have work2.txt
            const work1Path = path.join(TEST_DIR, ".worktrees", "feature-1", "work2.txt");
            await expect(fs.access(work1Path)).rejects.toThrow();
        });
    });
});
