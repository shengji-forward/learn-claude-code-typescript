# Session 11: Autonomous Agents

## Overview

This session introduces autonomous agents that can find and claim work independently. Learn how to implement idle cycle management and task claiming mechanisms.

### What You'll Learn

- **AutonomousManager**: Self-directed task claiming
- **Idle Cycle**: Poll for work during idle time
- **Task Scanning**: Find unclaimed tasks
- **Identity Re-injection**: Maintain agent identity
- **Worker Integration**: Run autonomous teammates

## Running the Session

```bash
npm run s11
# or
ts-node agents/s11_autonomous_agents.ts
```

## Key Implementation Details

### TypeScript vs Python

**Idle Polling**:
- **Python**: `time.sleep(POLL_INTERVAL)`
- **TypeScript**: `await sleep(POLL_INTERVAL * 1000)`
- **Why**: Promise-based non-blocking delays

**Task Scanning**:
- **Python**: `glob("task_*.json")`
- **TypeScript**: `fs.readdir()` with filter
- **Why**: Better type safety

**File Locking**:
- **Python**: `threading.Lock()` for claims
- **TypeScript**: No locks needed (single-threaded event loop)
- **Why**: Atomic operations sufficient

## Code Examples

### Task Scanning and Claiming

```typescript
class TaskManager {
    async scanUnclaimedTasks(): Promise<Task[]> {
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

        return unclaimed.sort((a, b) => a.id - b.id);
    }

    async claimTask(taskId: number, owner: string): Promise<string> {
        const taskPath = path.join(this.tasksDir, `task_${taskId}.json`);
        const content = await fs.readFile(taskPath, "utf-8");
        const task: Task = JSON.parse(content);

        task.owner = owner;
        task.status = TaskStatus.IN_PROGRESS;

        await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");

        return `Claimed task #${taskId} for ${owner}`;
    }
}
```

### Idle Cycle Management

```typescript
const POLL_INTERVAL = 5;  // seconds
const IDLE_TIMEOUT = 60;  // seconds

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function idleCycle(agentName: string): Promise<void> {
    const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

    for (let i = 0; i < polls; i++) {
        await sleep(POLL_INTERVAL * 1000);

        // Check inbox
        const inbox = await BUS.readInbox(agentName);
        if (inbox.length > 0) {
            for (const msg of inbox) {
                if (msg.type === "shutdown_request") {
                    return; // Exit idle cycle
                }
                messages.push({
                    role: "user",
                    content: JSON.stringify(msg),
                });
            }
            break; // Resume work
        }

        // Scan for unclaimed tasks
        const unclaimed = await TASKS.scanUnclaimedTasks();
        if (unclaimed.length > 0) {
            const task = unclaimed[0];
            await TASKS.claimTask(task.id, agentName);

            // Re-inject identity if context compressed
            if (messages.length <= 3) {
                messages.unshift(makeIdentityBlock(agentName, "developer", "my-team"));
            }

            const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description}</auto-claimed>`;
            messages.push({ role: "user", content: taskPrompt });

            break; // Resume work
        }
    }
}

function makeIdentityBlock(name: string, role: string, teamName: string): Message {
    return {
        role: "user",
        content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
    };
}
```

### Autonomous Tools

```typescript
const idleHandler: ToolHandler = async () => {
    console.log("💤 Entering idle cycle...");
    await idleCycle("teammate");
    return "Idle cycle complete, resuming work";
};

const claimTaskHandler: ToolHandler = async (input: unknown) => {
    const { task_id } = input as { task_id: number };

    const result = await TASKS.claimTask(task_id, "teammate");
    return result;
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│         Idle Cycle                      │
├─────────────────────────────────────────┤
│  1. Sleep for POLL_INTERVAL            │
│  2. Check inbox for messages           │
│  3. Scan for unclaimed tasks           │
│  4. If message/task: resume work       │
│  5. If timeout: shutdown               │
└─────────────────────────────────────────┘
```

## Best Practices

1. **Poll conservatively** to avoid resource usage
2. **Re-inject identity** after compression
3. **Claim tasks atomically** to prevent conflicts
4. **Handle timeouts** gracefully
5. **Log idle activities** for debugging

## Summary

Autonomous agents find work independently through idle polling. Task scanning identifies available work, while claiming ensures ownership. Identity re-injection maintains agent context after compression.

**Key Takeaways**:
- Idle cycle with polling
- Automatic task claiming
- Identity re-injection
- No locks needed (single-threaded)
- Worker-based autonomous teammates
