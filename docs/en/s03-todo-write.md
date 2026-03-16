# Session 3: Todo Write

## Overview

This session adds progress tracking to agents with a todo list system. Learn how to create, manage, and display todo items that help agents track their progress on complex tasks.

### What You'll Learn

- **TodoManager Class**: Encapsulate todo list logic
- **JSON Persistence**: Save todos to disk
- **Array Manipulation**: Type-safe array operations
- **String Formatting**: Display todos with status markers
- **Progress Tracking**: Track agent state through todos

## Running the Session

```bash
npm run s03
# or
ts-node agents/s03_todo_write.ts
```

## Key Implementation Details

### TypeScript vs Python

**Class Encapsulation**:
- **Python**: Functions with global state
- **TypeScript**: Class with private fields and methods
- **Why**: Better organization and encapsulation

**JSON Operations**:
- **Python**: `json.load()` and `json.dump()`
- **TypeScript**: `JSON.parse()` and `JSON.stringify()`
- **Why**: Built-in JSON handling with type safety

**File Operations**:
- **Python**: Synchronous file I/O
- **TypeScript**: Async file I/O with fs/promises
- **Why**: Non-blocking operations

## Code Examples

### Todo Interface

```typescript
interface Todo {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
}

interface TodoList {
    items: Todo[];
}
```

### TodoManager Class

```typescript
import { promises as fs } from "fs";
import * as path from "path";

class TodoManager {
    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async init(): Promise<void> {
        // Ensure directory exists
        const dir = path.dirname(this.filePath);
        await fs.mkdir(dir, { recursive: true });

        // Create file if it doesn't exist
        try {
            await fs.access(this.filePath);
        } catch {
            await fs.writeFile(this.filePath, JSON.stringify({ items: [] }, null, 2), "utf-8");
        }
    }

    async addTodos(items: Todo[]): Promise<void> {
        const data = await this.load();
        data.items.push(...items);
        await this.save(data);
    }

    async updateTodo(index: number, status: Todo["status"]): Promise<void> {
        const data = await this.load();
        if (index >= 0 && index < data.items.length) {
            data.items[index].status = status;
            await this.save(data);
        }
    }

    async listTodos(): Promise<string> {
        const data = await this.load();
        if (data.items.length === 0) {
            return "No todos.";
        }

        const lines = data.items.map((todo, index) => {
            const marker = {
                pending: "[ ]",
                in_progress: "[>]",
                completed: "[x]",
            }[todo.status];

            return `${marker} ${index + 1}. ${todo.content}`;
        });

        return lines.join("\n");
    }

    private async load(): Promise<TodoList> {
        const content = await fs.readFile(this.filePath, "utf-8");
        return JSON.parse(content);
    }

    private async save(data: TodoList): Promise<void> {
        await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    }
}
```

### TodoWrite Tool Handler

```typescript
const TODOS = new TodoManager(".todos.json");

const todoWriteHandler: ToolHandler = async (input: unknown) => {
    const { items } = input as { items: Todo[] };

    // Validate items
    if (!Array.isArray(items)) {
        return "Error: items must be an array";
    }

    // Validate each todo
    for (const item of items) {
        if (!item.content || typeof item.content !== "string") {
            return "Error: Each todo must have a content string";
        }
        if (!["pending", "in_progress", "completed"].includes(item.status)) {
            return "Error: Invalid status";
        }
    }

    await TODOS.addTodos(items);
    return `Added ${items.length} todo(s)`;
};
```

### System Prompt Integration

```typescript
const SYSTEM = `You are a coding agent with task tracking capabilities.

Use TodoWrite to track your progress:
- Set status to "pending" for future tasks
- Set status to "in_progress" when working on a task
- Set status to "completed" when finished

Example:
TodoWrite: {
  "items": [
    {"content": "Read the file", "status": "completed"},
    {"content": "Analyze code", "status": "in_progress"},
    {"content": "Write solution", "status": "pending"}
  ]
}`;
```

## Architecture

```
┌─────────────────────────────────────────┐
│           TodoManager                   │
├─────────────────────────────────────────┤
│  + addTodos(items: Todo[]): Promise    │
│  + updateTodo(index, status): Promise  │
│  + listTodos(): Promise<string>        │
│  - load(): Promise<TodoList>           │
│  - save(data): Promise<void>           │
└─────────────────────────────────────────┘
```

## TypeScript-Specific Features

### Enum for Status

```typescript
enum TodoStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

interface Todo {
    content: string;
    status: TodoStatus;
    activeForm?: string;
}
```

### Type Guards

```typescript
function isValidTodo(item: unknown): item is Todo {
    return typeof item === "object" && item !== null &&
        "content" in item &&
        "status" in item &&
        ["pending", "in_progress", "completed"].includes((item as any).status);
}
```

### Readonly Arrays

```typescript
function listCompletedTodos(todos: readonly Todo[]): string {
    return todos
        .filter(todo => todo.status === "completed")
        .map(todo => todo.content)
        .join("\n");
}
```

## Best Practices

1. **Validate input** before processing
2. **Use enums** for fixed status values
3. **Handle file errors** gracefully
4. **Provide feedback** on operations
5. **Use descriptive messages** for status

## Summary

Todo tracking provides agents with memory of their progress. The TodoManager class encapsulates todo logic with JSON persistence. TypeScript's type system ensures todo items are valid before saving.

**Key Takeaways**:
- Classes encapsulate related logic
- JSON files provide simple persistence
- Type validation prevents errors
- Status markers help track progress
