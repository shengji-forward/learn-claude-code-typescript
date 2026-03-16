# Session 7: Task System

## Overview

This session introduces a task management system with JSON persistence. Learn how to create, update, and manage tasks with dependency tracking and status updates.

### What You'll Learn

- **TaskManager Class**: CRUD operations for tasks
- **JSON Persistence**: Save tasks to disk
- **Dependency Graph**: Track task dependencies
- **Status Tracking**: Monitor task progress
- **Type Safety**: Ensure task data integrity

## Running the Session

```bash
npm run s07
# or
ts-node agents/s07_task_system.ts
```

## Key Implementation Details

### TypeScript vs Python

**Type Safety**:
- **Python**: Dict with runtime validation
- **TypeScript**: Interfaces with compile-time checking
- **Why**: Catch errors before runtime

**Enum Status**:
- **Python**: String literals
- **TypeScript**: Enum for compile-time safety
- **Why**: Prevent invalid status values

**Async Operations**:
- **Python**: Synchronous file I/O
- **TypeScript**: Async file I/O with fs/promises
- **Why**: Non-blocking operations

## Code Examples

### Task Interface and Enum

```typescript
enum TaskStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

interface Task {
    id: number;
    subject: string;
    description: string;
    status: TaskStatus;
    owner?: string;
    blockedBy: string[];
    createdAt: number;
    updatedAt: number;
}
```

### TaskManager Class

```typescript
class TaskManager {
    private tasksDir: string;

    constructor(tasksDir: string) {
        this.tasksDir = tasksDir;
    }

    async init(): Promise<void> {
        await fs.mkdir(this.tasksDir, { recursive: true });
    }

    async create(subject: string, description: string, owner: string = "lead"): Promise<Task> {
        const tasks = await this.listAll();
        const newId = tasks.length > 0 ? Math.max(...tasks.map(t => t.id)) + 1 : 1;

        const task: Task = {
            id: newId,
            subject,
            description,
            status: TaskStatus.PENDING,
            owner,
            blockedBy: [],
            createdAt: Date.now() / 1000,
            updatedAt: Date.now() / 1000,
        };

        await this.save(task);
        return task;
    }

    async get(taskId: number): Promise<Task | null> {
        const taskPath = path.join(this.tasksDir, `task_${taskId}.json`);
        try {
            const content = await fs.readFile(taskPath, "utf-8");
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    async update(taskId: number, status: TaskStatus): Promise<void> {
        const task = await this.get(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        task.status = status;
        task.updatedAt = Date.now() / 1000;

        await this.save(task);
    }

    async listAll(): Promise<Task[]> {
        const files = await fs.readdir(this.tasksDir);
        const taskFiles = files.filter(f => f.startsWith("task_") && f.endsWith(".json"));

        const tasks: Task[] = [];
        for (const file of taskFiles) {
            const content = await fs.readFile(path.join(this.tasksDir, file), "utf-8");
            tasks.push(JSON.parse(content));
        }

        return tasks.sort((a, b) => a.id - b.id);
    }

    private async save(task: Task): Promise<void> {
        const taskPath = path.join(this.tasksDir, `task_${task.id}.json`);
        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
    }
}
```

### Task Tools

```typescript
const TASKS = new TaskManager(".tasks");

const taskCreateHandler: ToolHandler = async (input: unknown) => {
    const { subject, description, owner } = input as {
        subject: string;
        description: string;
        owner?: string;
    };

    const task = await TASKS.create(subject, description, owner);
    return `Created task #${task.id}: ${task.subject}`;
};

const taskGetHandler: ToolHandler = async (input: unknown) => {
    const { task_id } = input as { task_id: number };
    const task = await TASKS.get(task_id);

    if (!task) {
        return `Task ${task_id} not found`;
    }

    return JSON.stringify(task, null, 2);
};

const taskUpdateHandler: ToolHandler = async (input: unknown) => {
    const { task_id, status } = input as {
        task_id: number;
        status: TaskStatus;
    };

    await TASKS.update(task_id, status);
    return `Updated task #${task_id} to ${status}`;
};

const taskListHandler: ToolHandler = async () => {
    const tasks = await TASKS.listAll();

    if (tasks.length === 0) {
        return "No tasks found.";
    }

    const lines = tasks.map(task => {
        const marker = {
            [TaskStatus.PENDING]: "[ ]",
            [TaskStatus.IN_PROGRESS]: "[>]",
            [TaskStatus.COMPLETED]: "[x]",
        }[task.status];

        return `${marker} #${task.id}: ${task.subject} (owner: ${task.owner})`;
    });

    return lines.join("\n");
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│           TaskManager                   │
├─────────────────────────────────────────┤
│  + create(subject, description)        │
│  + get(taskId): Task                   │
│  + update(taskId, status)              │
│  + listAll(): Task[]                   │
│  - save(task): Promise<void>           │
└─────────────────────────────────────────┘
```

## Best Practices

1. **Use enums** for status values
2. **Validate input** before creating tasks
3. **Handle missing tasks** gracefully
4. **Track timestamps** for auditing
5. **Use descriptive subjects** for clarity

## Summary

The task system provides structured work tracking with JSON persistence. TypeScript enums ensure status validity, while interfaces guarantee task structure integrity.

**Key Takeaways**:
- JSON files for persistence
- Enums for type-safe status
- CRUD operations for tasks
- Dependency tracking support
