# Session 8: Background Tasks

## Overview

This session introduces background task execution using Worker Threads. Learn how to run long-running commands without blocking the agent loop.

### What You'll Learn

- **Worker Threads**: Parallel execution
- **Task Queue**: Queue background tasks
- **Notification System**: Check task completion
- **Non-blocking Operations**: Keep agent responsive
- **Error Handling**: Manage worker failures

## Running the Session

```bash
npm run s08
# or
ts-node agents/s08_background_tasks.ts
```

## Key Implementation Details

### TypeScript vs Python

**Threading**:
- **Python**: `threading.Thread` with GIL limitations
- **TypeScript**: `worker_threads` with true parallelism
- **Why**: Better performance for CPU-bound tasks

**Communication**:
- **Python**: Shared memory with locks
- **TypeScript**: Message passing between workers
- **Why**: Safer concurrent execution

**Async/Await**:
- **Python**: Synchronous execution
- **TypeScript**: Async operations throughout
- **Why**: Non-blocking I/O

## Code Examples

### Worker Script (workers/task-worker.ts)

```typescript
import { parentPort, workerData } from "worker_threads";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface TaskData {
    taskId: string;
    command: string;
    timeout: number;
}

interface TaskResult {
    taskId: string;
    success: boolean;
    output: string;
    error?: string;
}

async function runTask(data: TaskData): Promise<TaskResult> {
    try {
        const { stdout, stderr } = await execAsync(data.command, {
            timeout: data.timeout * 1000,
        });

        return {
            taskId: data.taskId,
            success: true,
            output: (stdout + stderr).trim(),
        };
    } catch (error: any) {
        return {
            taskId: data.taskId,
            success: false,
            output: "",
            error: error.message,
        };
    }
}

// Receive task from main thread
parentPort?.on("message", async (data: TaskData) => {
    const result = await runTask(data);
    parentPort?.postMessage(result);
});
```

### BackgroundManager Class

```typescript
import { Worker } from "worker_threads";

class BackgroundManager {
    private workers: Map<string, Worker> = new Map();
    private results: Map<string, TaskResult> = new Map();

    async run(command: string, timeout: number = 300): Promise<string> {
        const taskId = `task_${Date.now()}`;

        return new Promise((resolve, reject) => {
            const worker = new Worker("./workers/task-worker.ts", {
                workerData: { taskId, command, timeout },
            });

            worker.on("message", (result: TaskResult) => {
                this.results.set(taskId, result);
                this.workers.delete(taskId);

                if (result.success) {
                    resolve(result.output);
                } else {
                    reject(new Error(result.error || "Task failed"));
                }
            });

            worker.on("error", (error) => {
                this.workers.delete(taskId);
                reject(error);
            });

            this.workers.set(taskId, worker);
        });
    }

    async check(taskId: string): Promise<TaskResult | null> {
        return this.results.get(taskId) || null;
    }

    getActiveTasks(): string[] {
        return Array.from(this.workers.keys());
    }
}
```

### Background Tools

```typescript
const BACKGROUND = new BackgroundManager();

const backgroundRunHandler: ToolHandler = async (input: unknown) => {
    const { command, timeout } = input as {
        command: string;
        timeout?: number;
    };

    const taskId = `task_${Date.now()}`;
    console.log(`🔄 Starting background task: ${taskId}`);

    // Start task in background
    BACKGROUND.run(command, timeout || 300)
        .then(output => {
            console.log(`✅ Task ${taskId} completed:\n${output}`);
        })
        .catch(error => {
            console.error(`❌ Task ${taskId} failed: ${error.message}`);
        });

    return `Started background task ${taskId}. Use background_check to monitor.`;
};

const backgroundCheckHandler: ToolHandler = async (input: unknown) => {
    const { task_id } = input as { task_id: string };

    const result = await BACKGROUND.check(task_id);
    if (!result) {
        return "Task not found or still running";
    }

    if (result.success) {
        return `Task completed:\n${result.output}`;
    } else {
        return `Task failed: ${result.error}`;
    }
};
```

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│   Main Thread        │         │   Worker Thread      │
├──────────────────────┤         ├──────────────────────┤
│  + run(command)      │ ──────> │  + exec(command)     │
│  + check(taskId)     │ <────── │  + postMessage()     │
│  + getActiveTasks()  │         │  + runTask()         │
└──────────────────────┘         └──────────────────────┘
```

## Best Practices

1. **Set timeouts** to prevent hanging
2. **Monitor workers** for errors
3. **Clean up workers** after completion
4. **Check task status** before blocking
5. **Handle failures** gracefully

## Summary

Background tasks enable long-running operations without blocking. Worker threads provide true parallelism in TypeScript. Message passing ensures safe communication.

**Key Takeaways**:
- Worker threads for parallelism
- Message passing for safety
- Non-blocking operations
- Task result tracking
