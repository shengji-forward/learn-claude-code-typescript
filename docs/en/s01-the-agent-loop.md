# Session 1: The Agent Loop

## Overview

This session introduces the fundamental agent loop pattern - the core architecture for building AI coding agents with Claude. You'll learn how to create an interactive agent that can use tools, maintain conversation context, and provide intelligent responses.

### What You'll Learn

- **Async/Await Pattern**: How to use TypeScript's async/await for API calls
- **Agent Loop Structure**: The while loop that powers agent conversations
- **Tool Use**: How to provide tools to Claude and handle tool results
- **Message Management**: Building conversation history with proper typing
- **Error Handling**: Type-safe error handling with TypeScript

## Running the Session

```bash
npm run s01
# or
ts-node agents/s01_agent_loop.ts
```

## Key Implementation Details

### TypeScript vs Python

**Async Operations**:
- **Python**: Synchronous API calls with `client.messages.create()`
- **TypeScript**: Async API calls with `await client.messages.create()`
- **Why**: TypeScript uses Promises for non-blocking I/O operations

**Type Safety**:
- **Python**: Dynamic typing with runtime validation
- **TypeScript**: Compile-time type checking with interfaces
- **Why**: Catch errors before runtime, better IDE support

**Message Structure**:
- **Python**: Dict-based messages with string keys
- **TypeScript**: Typed interfaces and union types
- **Why**: Self-documenting code with autocomplete

## Code Examples

### Basic Agent Loop

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 8000,
            messages: messages,
        });

        // Add assistant response to history
        messages.push({
            role: "assistant",
            content: response.content,
        });

        // Check if agent wants to use tools
        if (response.stop_reason !== "tool_use") {
            return; // Conversation complete
        }

        // Execute tools and collect results
        const results = await executeTools(response.content);
        messages.push({
            role: "user",
            content: results,
        });
    }
}
```

### Type-Safe Messages

```typescript
interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: any }
    | { type: "tool_result"; tool_use_id: string; content: string };

const messages: Message[] = [
    {
        role: "user",
        content: "Hello, Claude!"
    }
];
```

### Tool Execution

```typescript
async function executeTools(blocks: ContentBlock[]): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const block of blocks) {
        if (block.type === "tool_use") {
            const output = await TOOL_HANDLERS[block.name](block.input);
            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
            });
        }
    }

    return results;
}
```

## Architecture

```
┌─────────────────────────────────────────┐
│            Agent Loop                    │
├─────────────────────────────────────────┤
│  1. Send messages to Claude API         │
│  2. Receive response with content       │
│  3. Check stop_reason                   │
│  4. If tool_use: execute tools          │
│  5. Add results to messages             │
│  6. Loop back to step 1                 │
└─────────────────────────────────────────┘
```

## TypeScript-Specific Features

### Interface Definitions

```typescript
interface AnthropicMessage {
    role: "user" | "assistant";
    content: string;
}

interface ToolUse {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}
```

### Error Handling

```typescript
try {
    const response = await client.messages.create({...});
} catch (error) {
    if (error instanceof Anthropic.Error) {
        console.error("API Error:", error.message);
    } else {
        console.error("Unknown error:", error);
    }
}
```

### Environment Variables

```typescript
import { config } from "dotenv";

config(); // Load .env file

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
}
```

## Common Patterns

### Pattern 1: Message Accumulation

```typescript
const messages: Message[] = [
    { role: "user", content: "Initial message" }
];

// Each loop iteration adds to messages
while (true) {
    // ... get response ...
    messages.push({ role: "assistant", content: response.content });

    // ... execute tools ...
    messages.push({ role: "user", content: toolResults });
}
```

### Pattern 2: Tool Result Handling

```typescript
for (const block of response.content) {
    if (block.type === "tool_use") {
        const result = await executeTool(block);
        results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
        });
    }
}
```

### Pattern 3: Loop Termination

```typescript
if (response.stop_reason !== "tool_use") {
    // Agent finished its work
    return;
}

// Continue loop for more tool use
```

## Best Practices

1. **Always use async/await** for API calls
2. **Type your messages** with proper interfaces
3. **Handle errors** with try/catch blocks
4. **Check stop_reason** before tool execution
5. **Maintain conversation history** in the messages array
6. **Use environment variables** for API keys
7. **Set appropriate max_tokens** for your use case

## Troubleshooting

**Issue**: "API key not found"
- **Solution**: Ensure `.env` file exists with `ANTHROPIC_API_KEY`

**Issue**: Type errors on response.content
- **Solution**: Use proper ContentBlock union types

**Issue**: Infinite loop
- **Solution**: Always check `stop_reason !== "tool_use"`

**Issue**: Tool results not appearing
- **Solution**: Ensure tool_result blocks have correct `tool_use_id`

## Next Steps

- **Session 2**: Learn how to add multiple tools with type-safe dispatch
- **Session 3**: Add todo tracking for agent progress
- **Session 4**: Spawn subagents for parallel work

## Summary

The agent loop is the foundation of all AI coding agents. In TypeScript, we use async/await for non-blocking API calls, interfaces for type safety, and proper error handling. This pattern will be used throughout all subsequent sessions.

**Key Takeaways**:
- Agent loops use `while (true)` with break conditions
- TypeScript provides compile-time type safety
- Async operations require `await` for API calls
- Tool use requires proper request/response correlation
- Message history maintains conversation context
