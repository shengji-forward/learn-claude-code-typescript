# Session 2: Tool Use

## Overview

This session expands on the agent loop by adding multiple tools with type-safe dispatch. You'll learn how to create a tool handler system that allows Claude to execute various operations like running bash commands, reading files, and writing files.

### What You'll Learn

- **Tool Dispatch Pattern**: Map tool names to handler functions
- **Type-Safe Inputs**: Define interfaces for tool parameters
- **Tool Result Correlation**: Match tool results with tool use IDs
- **Error Handling**: Graceful error handling in tool execution
- **Tool Registration**: Dynamically register tools with Claude

## Running the Session

```bash
npm run s02
# or
ts-node agents/s02_tool_use.ts
```

## Key Implementation Details

### TypeScript vs Python

**Tool Dispatch**:
- **Python**: Dictionary mapping tool names to functions
- **TypeScript**: Record<string, ToolHandler> with type safety
- **Why**: Compile-time checking of tool names and signatures

**Type Guards**:
- **Python**: Runtime type checking with isinstance()
- **TypeScript**: Type guards and instanceof checks
- **Why**: Type narrowing for better IDE support

**Interface Definitions**:
- **Python**: Dict with string keys
- **TypeScript: Interfaces with optional properties
- **Why**: Self-documenting with autocomplete

## Code Examples

### Tool Handler Interface

```typescript
interface ToolHandler {
    (input: unknown): Promise<string>;
}

interface Tool {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, {
            type: string;
            description: string;
        }>;
        required: string[];
    };
}

const TOOLS: Tool[] = [
    {
        name: "bash",
        description: "Run a bash command",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The command to run"
                }
            },
            required: ["command"]
        }
    },
    // ... more tools
];
```

### Tool Dispatch Map

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input: unknown) => {
        const { command } = input as { command: string };
        return await runBash(command);
    },

    read_file: async (input: unknown) => {
        const { path } = input as { path: string };
        return await readFile(path);
    },

    write_file: async (input: unknown) => {
        const { path, content } = input as { path: string; content: string };
        return await writeFile(path, content);
    },

    edit_file: async (input: unknown) => {
        const { path, old_text, new_text } = input as {
            path: string;
            old_text: string;
            new_text: string;
        };
        return await editFile(path, old_text, new_text);
    },
};
```

### Type-Safe Tool Execution

```typescript
async function executeTools(blocks: ContentBlock[]): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];

    for (const block of blocks) {
        if (block.type === "tool_use") {
            const handler = TOOL_HANDLERS[block.name];
            if (!handler) {
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: `Error: Unknown tool '${block.name}'`
                });
                continue;
            }

            try {
                const output = await handler(block.input);
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            } catch (error) {
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
                });
            }
        }
    }

    return results;
}
```

### Bash Tool Implementation

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function runBash(command: string): Promise<string> {
    // Dangerous command blocking
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            timeout: 30000, // 30 second timeout
        });
        return (stdout + stderr).trim() || "(no output)";
    } catch (error) {
        if ((error as any).code === "ETIMEDOUT") {
            return "Error: Command timeout (30s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}
```

### File Read Tool

```typescript
import { promises as fs } from "fs";
import * as path from "path";

async function readFile(filePath: string): Promise<string> {
    const WORKDIR = process.cwd();
    const safePath = path.resolve(WORKDIR, filePath);

    // Security: Ensure path doesn't escape workspace
    if (!safePath.startsWith(WORKDIR)) {
        return "Error: Path escapes workspace";
    }

    try {
        const content = await fs.readFile(safePath, "utf-8");
        return content.substring(0, 50000); // Limit size
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}
```

### File Write Tool

```typescript
async function writeFile(filePath: string, content: string): Promise<string> {
    const WORKDIR = process.cwd();
    const safePath = path.resolve(WORKDIR, filePath);

    if (!safePath.startsWith(WORKDIR)) {
        return "Error: Path escapes workspace";
    }

    try {
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, content, "utf-8");
        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}
```

### File Edit Tool

```typescript
async function editFile(filePath: string, oldText: string, newText: string): Promise<string> {
    const WORKDIR = process.cwd();
    const safePath = path.resolve(WORKDIR, filePath);

    if (!safePath.startsWith(WORKDIR)) {
        return "Error: Path escapes workspace";
    }

    try {
        const content = await fs.readFile(safePath, "utf-8");
        if (!content.includes(oldText)) {
            return "Error: old_text not found in file";
        }

        const updated = content.replace(oldText, newText);
        await fs.writeFile(safePath, updated, "utf-8");

        return "File edited successfully";
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}
```

## Architecture

```
┌──────────────────────────────────────────┐
│           Tool Dispatch System           │
├──────────────────────────────────────────┤
│  1. Define tool interfaces               │
│  2. Register tools with Claude API       │
│  3. Create handler functions             │
│  4. Map handlers to tool names           │
│  5. Execute tools via dispatch map       │
│  6. Return results with correlation IDs  │
└──────────────────────────────────────────┘
```

## TypeScript-Specific Features

### Type Guards

```typescript
function isToolUse(block: ContentBlock): block is ToolUseBlock {
    return block.type === "tool_use";
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
    return block.type === "tool_result";
}

// Usage
for (const block of response.content) {
    if (isToolUse(block)) {
        // TypeScript knows block is ToolUseBlock here
        const handler = TOOL_HANDLERS[block.name];
    }
}
```

### Discriminated Unions

```typescript
type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: any }
    | { type: "tool_result"; tool_use_id: string; content: string };

// TypeScript narrows type based on 'type' property
function processBlock(block: ContentBlock): string {
    switch (block.type) {
        case "text":
            return block.text; // OK
        case "tool_use":
            return block.name; // OK
        case "tool_result":
            return block.content; // OK
        default:
            const _exhaustive: never = block; // Compile-time check
            return _exhaustive;
    }
}
```

### Readonly Types

```typescript
const TOOLS: readonly Tool[] = [
    { name: "bash", description: "...", input_schema: {...} },
    { name: "read_file", description: "...", input_schema: {...} },
] as const;

// Prevents accidental modification
TOOLS.push({ name: "new_tool" }); // Compile error!
```

## Common Patterns

### Pattern 1: Safe Type Casting

```typescript
// Instead of 'as any', use proper type guards
function isValidBashInput(input: unknown): input is { command: string } {
    return typeof input === "object" && input !== null &&
        "command" in input &&
        typeof (input as any).command === "string";
}

const handler: ToolHandler = async (input: unknown) => {
    if (!isValidBashInput(input)) {
        return "Error: Invalid input";
    }
    return await runBash(input.command);
};
```

### Pattern 2: Error Wrapping

```typescript
async function safeExecute<T>(
    fn: () => Promise<T>,
    errorMessage: string
): Promise<string> {
    try {
        const result = await fn();
        return String(result);
    } catch (error) {
        return `${errorMessage}: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}
```

### Pattern 3: Tool Result Builder

```typescript
class ToolResultBuilder {
    private results: ToolResultBlock[] = [];

    addSuccess(toolUseId: string, content: string): void {
        this.results.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
        });
    }

    addError(toolUseId: string, error: Error): void {
        this.results.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            content: `Error: ${error.message}`,
        });
    }

    build(): ToolResultBlock[] {
        return this.results;
    }
}
```

## Best Practices

1. **Type your inputs** with proper interfaces
2. **Validate parameters** before execution
3. **Handle errors gracefully** with try/catch
4. **Use type guards** for type narrowing
5. **Limit output size** to prevent token overflow
6. **Set timeouts** on long-running operations
7. **Sanitize paths** to prevent directory traversal
8. **Block dangerous commands** at the tool level

## Troubleshooting

**Issue**: "Unknown tool" errors
- **Solution**: Ensure tool name in TOOLS matches handler key

**Issue**: Type errors on tool input
- **Solution**: Use proper type guards instead of 'as any'

**Issue**: Tool results not correlated
- **Solution**: Match tool_use_id correctly in results

**Issue**: Path traversal attacks
- **Solution**: Always resolve and validate paths against workspace

## Next Steps

- **Session 3**: Add todo tracking for agent progress
- **Session 4**: Spawn subagents for parallel work
- **Session 5**: Load skills from YAML files

## Summary

Tool use is the primary way Claude interacts with external systems. TypeScript provides type safety for tool inputs and outputs, making the system more reliable and easier to maintain. The dispatch pattern maps tool names to handler functions, with proper error handling and result correlation.

**Key Takeaways**:
- Use interfaces for tool schemas
- Map tool names to handler functions
- Type guards prevent runtime errors
- Error handling should be graceful
- Always validate user inputs
- Security is crucial (path validation, command blocking)
