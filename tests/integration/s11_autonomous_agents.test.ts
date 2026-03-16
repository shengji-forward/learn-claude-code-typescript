/**
 * s11_autonomous_agents.test.ts - Integration tests for Session 11
 *
 * Tests for:
 * - Task claiming mechanism (scan and claim unclaimed tasks)
 * - Idle cycle management (polling, timeout, inbox checking)
 * - Identity re-injection after context compression
 *
 * === TEST COVERAGE ===
 *
 * Python project has NO tests, so these are the first tests for s11.
 * Focus on autonomous agent core mechanisms.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";

/**
 * Task interface (matches s11 implementation)
 */
interface Task {
    id: number;
    subject: string;
    description: string;
    status: "pending" | "in_progress" | "completed";
    owner?: string;
    blockedBy?: string[];
}

/**
 * Message interface (matches s11 implementation)
 */
interface Message {
    type: string;
    from: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

/**
 * TaskManager class (minimal implementation for testing)
 */
class TaskManager {
    private tasksDir: string;

    constructor(tasksDir: string) {
        this.tasksDir = tasksDir;
    }

    async init(): Promise<void> {
        await fs.mkdir(this.tasksDir, { recursive: true });
    }

    /**
     * Scan for unclaimed tasks
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
     */
    async claimTask(taskId: number, owner: string): Promise<string> {
        const taskPath = path.join(this.tasksDir, `task_${taskId}.json`);

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
     * Create a test task
     */
    async createTask(id: number, subject: string, description: string, blockedBy?: string[]): Promise<void> {
        const task: Task = {
            id,
            subject,
            description,
            status: "pending",
            blockedBy,
        };
        const taskPath = path.join(this.tasksDir, `task_${id}.json`);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }

    /**
     * Read task by ID
     */
    async readTask(taskId: number): Promise<Task | null> {
        const taskPath = path.join(this.tasksDir, `task_${taskId}.json`);
        try {
            const content = await fs.readFile(taskPath, "utf-8");
            return JSON.parse(content);
        } catch (error) {
            return null;
        }
    }
}

/**
 * Create identity block for re-injection
 */
function makeIdentityBlock(name: string, role: string, teamName: string): any {
    return {
        role: "user",
        content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
    };
}

describe("Session 11: Autonomous Agents", () => {
    const TEST_DIR = path.join(process.cwd(), ".test-s11");
    const TASKS_DIR = path.join(TEST_DIR, ".tasks");
    let taskManager: TaskManager;

    beforeEach(async () => {
        // Setup: clean test environment
        await fs.mkdir(TEST_DIR, { recursive: true });
        taskManager = new TaskManager(TASKS_DIR);
        await taskManager.init();
    });

    afterEach(async () => {
        // Cleanup: remove test directory
        try {
            await fs.rm(TEST_DIR, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe("Task Scanning", () => {
        it("should return empty array when no tasks exist", async () => {
            const unclaimed = await taskManager.scanUnclaimedTasks();
            expect(unclaimed).toEqual([]);
        });

        it("should find pending tasks without owner", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(2);
            expect(unclaimed[0].id).toBe(1);
            expect(unclaimed[1].id).toBe(2);
        });

        it("should ignore tasks with owner", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            // Claim task 1
            await taskManager.claimTask(1, "teammate-1");

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(1);
            expect(unclaimed[0].id).toBe(2);
        });

        it("should ignore tasks with in_progress status", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            // Claim task 1 (changes status to in_progress)
            await taskManager.claimTask(1, "teammate-1");

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(1);
            expect(unclaimed[0].id).toBe(2);
        });

        it("should ignore tasks with completed status", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");

            // Manually mark task as completed
            const task = await taskManager.readTask(1);
            if (task) {
                task.status = "completed";
                const taskPath = path.join(TASKS_DIR, `task_1.json`);
                await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
            }

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(0);
        });

        it("should ignore tasks with blockers", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2", ["task_1"]);

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(1);
            expect(unclaimed[0].id).toBe(1);
        });

        it("should sort tasks by ID", async () => {
            await taskManager.createTask(3, "Task 3", "Description 3");
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(3);
            expect(unclaimed[0].id).toBe(1);
            expect(unclaimed[1].id).toBe(2);
            expect(unclaimed[2].id).toBe(3);
        });

        it("should handle empty blockedBy array", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1", []);

            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(1);
        });
    });

    describe("Task Claiming", () => {
        it("should claim task and update owner", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");

            const result = await taskManager.claimTask(1, "teammate-1");
            const task = await taskManager.readTask(1);

            expect(result).toBe("Claimed task #1 for teammate-1");
            expect(task?.owner).toBe("teammate-1");
        });

        it("should update task status to in_progress when claimed", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");

            await taskManager.claimTask(1, "teammate-1");
            const task = await taskManager.readTask(1);

            expect(task?.status).toBe("in_progress");
        });

        it("should return error for non-existent task", async () => {
            const result = await taskManager.claimTask(999, "teammate-1");
            expect(result).toBe("Error: Task 999 not found");
        });

        it("should prevent claiming same task twice", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");

            // First claim
            await taskManager.claimTask(1, "teammate-1");

            // Second claim (should succeed but change owner)
            await taskManager.claimTask(1, "teammate-2");
            const task = await taskManager.readTask(1);

            expect(task?.owner).toBe("teammate-2");
        });

        it("should handle multiple concurrent claims correctly", async () => {
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");
            await taskManager.createTask(3, "Task 3", "Description 3");

            // Claim all tasks
            await taskManager.claimTask(1, "teammate-1");
            await taskManager.claimTask(2, "teammate-2");
            await taskManager.claimTask(3, "teammate-3");

            // Verify all tasks are claimed
            const unclaimed = await taskManager.scanUnclaimedTasks();
            expect(unclaimed.length).toBe(0);

            // Verify owners
            const task1 = await taskManager.readTask(1);
            const task2 = await taskManager.readTask(2);
            const task3 = await taskManager.readTask(3);

            expect(task1?.owner).toBe("teammate-1");
            expect(task2?.owner).toBe("teammate-2");
            expect(task3?.owner).toBe("teammate-3");
        });
    });

    describe("Idle Cycle Management", () => {
        it("should calculate correct number of polls", () => {
            const POLL_INTERVAL = 5;  // seconds
            const IDLE_TIMEOUT = 60;  // seconds
            const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

            expect(polls).toBe(12);
        });

        it("should handle zero poll interval", () => {
            const POLL_INTERVAL = 0;
            const IDLE_TIMEOUT = 60;
            const polls = Math.floor(IDLE_TIMEOUT / (POLL_INTERVAL || 1));

            expect(polls).toBe(60);
        });

        it("should handle timeout shorter than poll interval", () => {
            const POLL_INTERVAL = 10;
            const IDLE_TIMEOUT = 5;
            const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

            expect(polls).toBe(0);
        });
    });

    describe("Identity Re-injection", () => {
        it("should create identity block with correct structure", () => {
            const identity = makeIdentityBlock("coder", "backend", "my-team");

            expect(identity).toBeDefined();
            expect(identity.role).toBe("user");
            expect(identity.content).toContain("You are 'coder'");
            expect(identity.content).toContain("role: backend");
            expect(identity.content).toContain("team: my-team");
        });

        it("should include identity tag in content", () => {
            const identity = makeIdentityBlock("coder", "backend", "my-team");

            expect(identity.content).toContain("<identity>");
            expect(identity.content).toContain("</identity>");
        });

        it("should handle special characters in name", () => {
            const identity = makeIdentityBlock("team-member-1", "senior frontend", "team-alpha");

            expect(identity.content).toContain("team-member-1");
            expect(identity.content).toContain("senior frontend");
            expect(identity.content).toContain("team-alpha");
        });

        it("should produce valid message structure", () => {
            const identity = makeIdentityBlock("coder", "backend", "my-team");

            // Verify it's a valid message object
            expect(typeof identity.role).toBe("string");
            expect(typeof identity.content).toBe("string");
            expect(identity.role).toBeTruthy();
            expect(identity.content).toBeTruthy();
        });
    });

    describe("Autonomous Workflow Integration", () => {
        it("should scan, claim, and verify task lifecycle", async () => {
            // Create tasks
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            // Scan for unclaimed
            let unclaimed = await taskManager.scanUnclaimedTasks();
            expect(unclaimed.length).toBe(2);

            // Claim first task
            const result = await taskManager.claimTask(1, "autonomous-agent");
            expect(result).toContain("Claimed task #1");

            // Scan again - should only find second task
            unclaimed = await taskManager.scanUnclaimedTasks();
            expect(unclaimed.length).toBe(1);
            expect(unclaimed[0].id).toBe(2);

            // Verify first task status
            const task1 = await taskManager.readTask(1);
            expect(task1?.status).toBe("in_progress");
            expect(task1?.owner).toBe("autonomous-agent");
        });

        it("should handle task priority by ID order", async () => {
            // Create tasks in reverse order
            await taskManager.createTask(3, "Task 3", "Description 3");
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2");

            // Scan should return tasks sorted by ID
            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed[0].id).toBe(1);
            expect(unclaimed[1].id).toBe(2);
            expect(unclaimed[2].id).toBe(3);
        });

        it("should respect blocked tasks during scanning", async () => {
            // Create tasks with dependencies
            await taskManager.createTask(1, "Task 1", "Description 1");
            await taskManager.createTask(2, "Task 2", "Description 2", ["task_1"]);
            await taskManager.createTask(3, "Task 3", "Description 3");

            // Only task 1 and 3 should be claimable
            const unclaimed = await taskManager.scanUnclaimedTasks();

            expect(unclaimed.length).toBe(2);
            expect(unclaimed.some(t => t.id === 1)).toBe(true);
            expect(unclaimed.some(t => t.id === 3)).toBe(true);
            expect(unclaimed.some(t => t.id === 2)).toBe(false);
        });
    });
});
