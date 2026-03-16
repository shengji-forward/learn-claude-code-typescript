# Capstone: Full Reference Agent

## Overview

The capstone (`agents/s_full.ts`) combines all mechanisms from sessions s01-s11 into a comprehensive reference implementation. This is NOT a teaching session - it's the "put it all together" reference showing how all components work together.

### What's Included

- **s01**: Agent loop with async/await
- **s02**: Type-safe tool dispatch
- **s03**: TodoManager for progress tracking
- **s04**: Subagent spawning with context isolation
- **s05**: Skill loading with YAML frontmatter
- **s06**: Context compression pipeline
- **s07**: Task system with JSON persistence
- **s08**: Background tasks with Worker Threads
- **s09**: Agent teams with JSONL messaging
- **s10**: Team protocols (request-response)
- **s11**: Autonomous agents (idle cycle)

**Excluded**: s12 (worktree isolation) - taught separately

## Running the Capstone

```bash
npm run s:full
# or
ts-node agents/s_full.ts
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    FULL AGENT                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  System Prompt:                                             │
│  - Task-first approach                                      │
│  - Optional todo nagging                                    │
│  - Skill loading support                                   │
│                                                             │
│  Before Each LLM Call:                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Microcompact │  │ Drain bg     │  │ Check inbox  │    │
│  │ (s06)        │  │ tasks (s08)  │  │ (s09)        │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                             │
│  Tool Dispatch (s02 pattern):                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ bash | read | write | edit | TodoWrite             │  │
│  │ task | load_skill | compress | bg_run | bg_check   │  │
│  │ t_crt | t_get | t_upd | t_list | spawn_tm         │  │
│  │ list_tm | send_msg | rd_inbox | bcast | shutdown   │  │
│  │ plan | idle | claim                                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Additional Features:                                       │
│  - Subagent spawning (s04)                                 │
│  - Teammate spawning (s09)                                 │
│  - Autonomous behavior (s11)                               │
│  - Protocol handling (s10)                                 │
│  - Context compression (s06)                                │
└─────────────────────────────────────────────────────────────┘
```

## Manager Classes

### TodoManager (s03)
```typescript
class TodoManager {
    private todosFile: string;
    async addTodos(items: Todo[]): Promise<void>
    async updateTodo(index: number, status: TodoStatus): Promise<void>
    async listTodos(): Promise<string>
}
```

### TaskManager (s07)
```typescript
class TaskManager {
    private tasksDir: string;
    async create(subject: string, description: string, owner: string): Promise<Task>
    async get(taskId: number): Promise<Task | null>
    async update(taskId: number, status: TaskStatus): Promise<void>
    async listAll(): Promise<Task[]>
}
```

### BackgroundManager (s08)
```typescript
class BackgroundManager {
    private workers: Map<string, Worker>
    async run(command: string, timeout?: number): Promise<string>
    async check(taskId: string): Promise<TaskResult | null>
}
```

### MessageBus (s09)
```typescript
class MessageBus {
    private inboxDir: string;
    async send(to: string, from: string, content: string, type?: string): Promise<void>
    async readInbox(name: string): Promise<Message[]>
}
```

### TeammateManager (s09)
```typescript
class TeammateManager {
    private dir: string;
    private workers: Map<string, Worker>
    async spawn(name: string, role: string, prompt: string): Promise<string>
    async listAll(): Promise<string>
}
```

### ProtocolManager (s10)
```typescript
class ProtocolManager {
    private shutdownRequests: Map<string, ProtocolRequest>
    private planRequests: Map<string, ProtocolRequest>
    createShutdownRequest(target: string): string
    createPlanRequest(from: string, plan: string): string
    updateShutdownStatus(requestId: string, approved: boolean): void
    updatePlanStatus(requestId: string, approved: boolean): void
}
```

## Tool Handlers

### File Operations (s02)
- **bash**: Run shell commands
- **read_file**: Read file contents
- **write_file**: Write file contents
- **edit_file**: Edit file by replacing text

### Todo Management (s03)
- **TodoWrite**: Update todo list

### Subagent (s04)
- **spawn_subagent**: Spawn isolated subagent

### Skills (s05)
- **load_skill**: Load specialized knowledge

### Compression (s06)
- **compress_context**: Compress conversation history

### Task Management (s07)
- **task_create**: Create new task
- **task_get**: Get task details
- **task_update**: Update task status
- **task_list**: List all tasks

### Background Tasks (s08)
- **background_run**: Run command in background
- **background_check**: Check background task status

### Team Operations (s09)
- **teammate_spawn**: Spawn new teammate
- **teammate_list**: List active teammates
- **send_message**: Send message to teammate
- **read_inbox**: Read inbox messages

### Protocols (s10)
- **shutdown_response**: Respond to shutdown request
- **plan_approval**: Submit plan for approval

### Autonomous (s11)
- **idle**: Enter idle cycle
- **claim_task**: Claim unclaimed task

## Integration Points

### Before Each LLM Call
```typescript
// 1. Microcompact to save tokens
if (messages.length > 10) {
    messages = microcompact(messages);
}

// 2. Check for auto-compact
const currentTokens = estimateTokens(JSON.stringify(messages));
if (currentTokens > TOKEN_THRESHOLD) {
    messages = autoCompact(messages);
}

// 3. Drain background notifications
const notifications = await BACKGROUND.checkAll();
if (notifications.length > 0) {
    messages.push({
        role: "user",
        content: `Background tasks completed:\n${notifications.join("\n")}`
    });
}

// 4. Check inbox
const inbox = await BUS.readInbox("lead");
if (inbox.length > 0) {
    for (const msg of inbox) {
        messages.push({
            role: "user",
            content: JSON.stringify(msg)
        });
    }
}
```

### Tool Result Processing
```typescript
for (const block of response.content) {
    if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        if (handler) {
            const output = await handler(block.input);
            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
            });
        }
    }
}
```

### REPL Integration
```typescript
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

console.log("Full Reference Agent");
console.log("Commands: /compact /tasks /team /inbox");

while (true) {
    const query = await question("\n> ");

    if (query === "/compact") {
        messages = autoCompact(messages);
        console.log("Context compressed");
        continue;
    }

    if (query === "/tasks") {
        console.log(await TASK_MGR.listAll());
        continue;
    }

    if (query === "/team") {
        console.log(await TEAM.listAll());
        continue;
    }

    if (query === "/inbox") {
        console.log(JSON.stringify(await BUS.readInbox("lead"), null, 2));
        continue;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);
}
```

## TypeScript-Specific Features

### Type Safety
```typescript
// All messages are properly typed
interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

// Content blocks use discriminated unions
type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: any }
    | { type: "tool_result"; tool_use_id: string; content: string };
```

### Async Operations
```typescript
// All SDK calls are async
const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: messages,
});

// All file operations use fs/promises
await fs.readFile(filePath, "utf-8");
await fs.writeFile(filePath, content, "utf-8");
```

### Error Handling
```typescript
try {
    const result = await someAsyncOperation();
} catch (error) {
    if (error instanceof Anthropic.Error) {
        console.error("API Error:", error.message);
    } else if (error instanceof Error) {
        console.error("Error:", error.message);
    } else {
        console.error("Unknown error:", error);
    }
}
```

## Self-Contained Implementation

The capstone is completely self-contained:
- No imports from other session files
- All interfaces defined within
- All manager classes defined within
- All tool handlers defined within

This makes it easy to:
- Study the complete implementation
- Understand how components integrate
- Copy patterns for your own agents

## Usage Patterns

### Basic Usage
```bash
npm run s:full
> Implement a feature to add two numbers
# Agent will use tools, manage todos, track progress
```

### With Tasks
```bash
npm run s:full
> Create a task for implementing user authentication
> task_create: { "subject": "User Auth", "description": "Implement login" }
> task_list
```

### With Team
```bash
npm run s:full
> Spawn a teammate to handle frontend work
> teammate_spawn: { "name": "frontend-dev", "role": "Frontend Developer", "prompt": "Build UI components" }
> send_message: { "to": "frontend-dev", "content": "Create login form" }
```

### With Protocols
```bash
npm run s:full
> Request team shutdown
> shutdown_request: { "target": "frontend-dev", "reason": "Work complete" }
```

## REPL Commands

- **/compact**: Manually compress context
- **/tasks**: List all tasks
- **/team**: List all teammates
- **/inbox**: Read inbox messages

## Key Differences from Python

1. **Async/Await**: All operations are async
2. **Type Safety**: Compile-time type checking
3. **Module System**: ES imports instead of Python imports
4. **Error Handling**: instanceof checks instead of type()
5. **File Operations**: fs/promises instead of pathlib
6. **Deep Cloning**: JSON.parse(JSON.stringify()) instead of copy.deepcopy()

## Best Practices

1. **Always use async/await** for async operations
2. **Type all interfaces** for compile-time safety
3. **Handle errors gracefully** with try/catch
4. **Compress context** before hitting token limits
5. **Check inbox** before each LLM call
6. **Drain background** notifications regularly
7. **Use tasks** for multi-step work
8. **Monitor teammates** for proper shutdown

## Summary

The capstone demonstrates how all components integrate into a production-ready agent. It's self-contained, type-safe, and follows TypeScript best practices. Use it as a reference for building your own agents.

**Key Takeaways**:
- All mechanisms integrate seamlessly
- Type safety prevents runtime errors
- Async operations are non-blocking
- Modular design enables extensibility
- Self-contained for easy study
