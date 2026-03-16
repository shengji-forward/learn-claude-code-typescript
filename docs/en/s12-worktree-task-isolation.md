# Session 12: Worktree Task Isolation

## Overview

This session introduces directory-level isolation for parallel task execution using git worktrees. Learn how to bind tasks to worktrees and execute work in isolated environments.

### What You'll Learn

- **WorktreeManager**: Create and manage git worktrees
- **Task-Worktree Binding**: Link tasks to worktrees
- **Isolated Execution**: Run commands in worktrees
- **Event Logging**: Track worktree lifecycle
- **Git Integration**: Use git for isolation

## Running the Session

```bash
npm run s12
# or
ts-node agents/s12_worktree_task_isolation.ts
```

## Key Implementation Details

### TypeScript vs Python

**Git Operations**:
- **Python**: `subprocess.run(["git", ...])`
- **TypeScript**: `execAsync()` with shell commands
- **Why**: Simpler API with async/await

**Path Validation**:
- **Python**: `pathlib.Path.is_relative_to()`
- **TypeScript**: `path.resolve()` with `startsWith()`
- **Why**: Cross-platform compatibility

**Type Safety**:
- **Python**: Runtime validation
- **TypeScript**: Compile-time checking
- **Why**: Catch errors early

## Code Examples

### Worktree Interfaces

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
    owner: string;
    worktree: string;
    blockedBy: string[];
    createdAt: number;
    updatedAt: number;
}

enum WorktreeStatus {
    ACTIVE = "active",
    REMOVED = "removed",
    KEPT = "kept",
}

interface Worktree {
    name: string;
    path: string;
    branch: string;
    task_id?: number;
    status: WorktreeStatus;
    createdAt: number;
    removedAt?: number;
    keptAt?: number;
}
```

### WorktreeManager Class

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

class WorktreeManager {
    private repoRoot: string;
    private tasks: TaskManager;
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

    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });

        // Check if git is available
        try {
            await execAsync("git rev-parse --is-inside-work-tree", {
                cwd: this.repoRoot,
                timeout: 10000,
            });
            this.gitAvailable = true;
        } catch {
            this.gitAvailable = false;
        }
    }

    async create(name: string, taskId?: number, baseRef: string = "HEAD"): Promise<string> {
        if (!this.gitAvailable) {
            throw new Error("Not in a git repository");
        }

        const worktreePath = path.join(this.dir, name);
        const branch = `wt/${name}`;

        // Create git worktree
        await execAsync(`git worktree add -b ${branch} ${worktreePath} ${baseRef}`, {
            cwd: this.repoRoot,
            timeout: 120000,
        });

        // Update index
        const worktree: Worktree = {
            name,
            path: worktreePath,
            branch,
            task_id: taskId,
            status: WorktreeStatus.ACTIVE,
            createdAt: Date.now() / 1000,
        };

        await this.updateIndex(worktree);

        // Bind to task if provided
        if (taskId !== undefined) {
            await this.tasks.bindWorktree(taskId, name);
        }

        return JSON.stringify(worktree, null, 2);
    }

    async run(name: string, command: string): Promise<string> {
        const worktree = await this.find(name);
        if (!worktree) {
            throw new Error(`Worktree '${name}' not found`);
        }

        const { stdout, stderr } = await execAsync(command, {
            cwd: worktree.path,
            timeout: 300000,
        });

        return (stdout + stderr).trim();
    }

    async remove(name: string, force: boolean = false, completeTask: boolean = false): Promise<string> {
        const worktree = await this.find(name);
        if (!worktree) {
            throw new Error(`Worktree '${name}' not found`);
        }

        // Remove git worktree
        const args = ["worktree", "remove"];
        if (force) args.push("--force");
        args.push(worktree.path);

        await execAsync(`git ${args.join(" ")}`, {
            cwd: this.repoRoot,
            timeout: 120000,
        });

        // Complete task if requested
        if (completeTask && worktree.task_id !== undefined) {
            await this.tasks.update(worktree.task_id, TaskStatus.COMPLETED);
            await this.tasks.unbindWorktree(worktree.task_id);
        }

        // Update index
        await this.markRemoved(name);

        return `Removed worktree '${name}'`;
    }

    private async find(name: string): Promise<Worktree | undefined> {
        const index = await this.loadIndex();
        return index.worktrees.find(wt => wt.name === name);
    }

    private async loadIndex(): Promise<{ worktrees: Worktree[] }> {
        try {
            const content = await fs.readFile(this.indexPath, "utf-8");
            return JSON.parse(content);
        } catch {
            return { worktrees: [] };
        }
    }

    private async updateIndex(worktree: Worktree): Promise<void> {
        const index = await this.loadIndex();
        index.worktrees.push(worktree);
        await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
    }

    private async markRemoved(name: string): Promise<void> {
        const index = await this.loadIndex();
        const worktree = index.worktrees.find(wt => wt.name === name);
        if (worktree) {
            worktree.status = WorktreeStatus.REMOVED;
            worktree.removedAt = Date.now() / 1000;
        }
        await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
    }
}
```

### Worktree Tools

```typescript
const WORKTREES = new WorktreeManager(process.cwd(), TASKS, EVENTS);

const worktreeCreateHandler: ToolHandler = async (input: unknown) => {
    const { name, task_id, base_ref } = input as {
        name: string;
        task_id?: number;
        base_ref?: string;
    };

    return await WORKTREES.create(name, task_id, base_ref);
};

const worktreeRunHandler: ToolHandler = async (input: unknown) => {
    const { name, command } = input as {
        name: string;
        command: string;
    };

    return await WORKTREES.run(name, command);
};

const worktreeRemoveHandler: ToolHandler = async (input: unknown) => {
    const { name, force, complete_task } = input as {
        name: string;
        force?: boolean;
        complete_task?: boolean;
    };

    return await WORKTREES.remove(name, force, complete_task);
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│         WorktreeManager                 │
├─────────────────────────────────────────┤
│  + create(name, taskId?, baseRef?)    │
│  + run(name, command)                  │
│  + remove(name, force?, completeTask?) │
│  + status(name)                        │
│  + listAll()                           │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│           TaskManager                   │
├─────────────────────────────────────────┤
│  + bindWorktree(taskId, worktree)      │
│  + unbindWorktree(taskId)              │
└─────────────────────────────────────────┘
```

## Best Practices

1. **Validate worktree names** to prevent conflicts
2. **Check git availability** before operations
3. **Clean up worktrees** after task completion
4. **Handle missing worktrees** gracefully
5. **Log all operations** for debugging

## Summary

Worktree isolation enables parallel task execution in separate directories. Git worktrees provide isolation without full repository clones. Task-worktree binding coordinates control and execution planes.

**Key Takeaways**:
- Git worktrees for isolation
- Task-worktree binding
- Directory-level isolation
- Event logging for lifecycle
- Async git operations
