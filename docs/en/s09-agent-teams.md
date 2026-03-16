# Session 9: Agent Teams

## Overview

This session introduces agent teams for collaborative work. Learn how to spawn multiple teammates, communicate via message bus, and delegate work.

### What You'll Learn

- **TeammateManager**: Manage multiple agents
- **MessageBus**: JSONL-based communication
- **Team Configuration**: Persistent team state
- **Async Communication**: Non-blocking messaging
- **Worker Integration**: Run teammates in workers

## Running the Session

```bash
npm run s09
# or
ts-node agents/s09_agent_teams.ts
```

## Key Implementation Details

### TypeScript vs Python

**Message Bus**:
- **Python**: Global MessageBus instance
- **TypeScript**: Class with async methods
- **Why**: Better encapsulation

**Worker Threads**:
- **Python**: Threading with limitations
- **TypeScript**: worker_threads for true parallelism
- **Why**: Better isolation

**Async Operations**:
- **Python**: Synchronous file I/O
- **TypeScript**: Async file I/O throughout
- **Why**: Non-blocking operations

## Code Examples

### MessageBus Class

```typescript
class MessageBus {
    private inboxDir: string;

    constructor(inboxDir: string) {
        this.inboxDir = inboxDir;
    }

    async init(): Promise<void> {
        await fs.mkdir(this.inboxDir, { recursive: true });
    }

    async send(to: string, from: string, content: string, type: string = "message"): Promise<void> {
        const message = {
            type,
            from,
            content,
            timestamp: Date.now() / 1000,
        };

        const inboxPath = path.join(this.inboxDir, `${to}.jsonl`);
        const jsonLine = JSON.stringify(message) + "\n";

        await fs.appendFile(inboxPath, jsonLine, "utf-8");
    }

    async readInbox(name: string): Promise<Message[]> {
        const inboxPath = path.join(this.inboxDir, `${name}.jsonl`);

        try {
            const content = await fs.readFile(inboxPath, "utf-8");
            const lines = content.trim().split("\n").filter(Boolean);

            return lines.map(line => JSON.parse(line));
        } catch {
            return [];
        }
    }
}
```

### TeammateManager Class

```typescript
class TeammateManager {
    private dir: string;
    private configPath: string;
    private workers: Map<string, Worker> = new Map();

    async spawn(name: string, role: string, prompt: string): Promise<string> {
        const worker = new Worker("./workers/teammate-worker.ts", {
            workerData: { name, role, prompt, workdir: process.cwd() },
        });

        worker.on("exit", (code) => {
            this.workers.delete(name);
            console.log(`Teammate ${name} exited with code ${code}`);
        });

        this.workers.set(name, worker);
        return `Spawned teammate ${name} (${role})`;
    }

    listAll(): string {
        const teammates = Array.from(this.workers.keys());
        if (teammates.length === 0) {
            return "No teammates active.";
        }

        return teammates.map(name => `  - ${name}`).join("\n");
    }
}
```

### Team Tools

```typescript
const TEAM = new TeammateManager(".team");

const teammateSpawnHandler: ToolHandler = async (input: unknown) => {
    const { name, role, prompt } = input as {
        name: string;
        role: string;
        prompt: string;
    };

    return await TEAM.spawn(name, role, prompt);
};

const sendMessageHandler: ToolHandler = async (input: unknown) => {
    const { to, content } = input as { to: string; content: string };

    await BUS.send(to, "lead", content, "message");
    return `Sent message to ${to}`;
};

const readInboxHandler: ToolHandler = async () => {
    const messages = await BUS.readInbox("lead");
    return JSON.stringify(messages, null, 2);
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│           TeammateManager               │
├─────────────────────────────────────────┤
│  + spawn(name, role, prompt)           │
│  + listAll(): string                   │
│  + workers: Map<string, Worker>        │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│            MessageBus                   │
├─────────────────────────────────────────┤
│  + send(to, from, content)             │
│  + readInbox(name): Message[]          │
└─────────────────────────────────────────┘
```

## Best Practices

1. **Use unique names** for teammates
2. **Monitor worker status** continuously
3. **Handle worker failures** gracefully
4. **Clean up inboxes** regularly
5. **Log all messages** for debugging

## Summary

Agent teams enable parallel work with multiple agents. MessageBus provides JSONL-based communication. Worker threads isolate teammate execution.

**Key Takeaways**:
- Worker threads for isolation
- JSONL for message persistence
- Async communication
- Team configuration persistence
