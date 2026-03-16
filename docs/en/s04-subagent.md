# Session 4: Subagent

## Overview

This session introduces subagent spawning - the ability to create isolated agent contexts for parallel work. Learn how to spawn subagents, isolate their contexts, and collect their results.

### What You'll Learn

- **Context Isolation**: Deep cloning for independent contexts
- **Subagent Loop**: Run agent loop in isolation
- **Result Collection**: Gather subagent outputs
- **Worker Threads**: Parallel execution (future sessions)
- **Memory Management**: Clean up subagent contexts

## Running the Session

```bash
npm run s04
# or
ts-node agents/s04_subagent.ts
```

## Key Implementation Details

### TypeScript vs Python

**Deep Cloning**:
- **Python**: `copy.deepcopy(messages)`
- **TypeScript**: `JSON.parse(JSON.stringify(messages))`
- **Why**: TypeScript lacks built-in deep copy

**Context Isolation**:
- **Python**: Subprocess with separate interpreter
- **TypeScript**: Same process with cloned context
- **Why**: Simpler for basic use cases

**Type Safety**:
- **Python**: Dynamic typing in subagent
- **TypeScript**: Type-safe context passing
- **Why**: Compile-time guarantees

## Code Examples

### Deep Clone Function

```typescript
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

// Usage
const originalMessages: Message[] = [...];
const clonedMessages = deepClone(originalMessages);

// Modifications to clone don't affect original
clonedMessages.push({ role: "user", content: "New message" });
console.log(originalMessages.length); // Original unchanged
```

### Subagent Spawn Handler

```typescript
async function spawnSubagent(prompt: string, context: Message[]): Promise<string> {
    // Create isolated context by deep cloning
    const subagentMessages: Message[] = deepClone(context);

    // Add the new task
    subagentMessages.push({
        role: "user",
        content: prompt,
    });

    // Run subagent loop
    await agentLoop(subagentMessages);

    // Extract final response
    const lastMessage = subagentMessages[subagentMessages.length - 1];
    if (lastMessage.role === "assistant") {
        const content = lastMessage.content as ContentBlock[];
        const textBlocks = content.filter(block => block.type === "text");
        return textBlocks.map(block => (block as any).text).join("\n");
    }

    return "No response from subagent";
}
```

### Tool Registration

```typescript
const TOOLS: Tool[] = [
    // ... other tools
    {
        name: "spawn_subagent",
        description: "Spawn a subagent with isolated context for parallel work",
        input_schema: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Task for the subagent"
                },
                context_length: {
                    type: "number",
                    description: "Number of recent messages to include"
                }
            },
            required: ["prompt"]
        }
    }
];
```

### Subagent Handler Implementation

```typescript
const spawnSubagentHandler: ToolHandler = async (input: unknown) => {
    const { prompt, context_length = 10 } = input as {
        prompt: string;
        context_length?: number;
    };

    // Get recent messages for context
    const recentMessages = messages.slice(-context_length);

    console.log(`\n🔷 Spawning subagent with prompt: "${prompt}"`);

    const summary = await spawnSubagent(prompt, recentMessages);

    console.log(`🔷 Subagent completed:\n${summary}\n`);

    return summary;
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│           Main Agent                    │
│  + messages: Message[]                 │
└──────────┬──────────────────────────────┘
           │ spawn_subagent
           ▼
┌─────────────────────────────────────────┐
│         Subagent (Isolated)             │
│  + clonedMessages: Message[]           │
│  + agentLoop()                         │
│  + Returns summary                     │
└─────────────────────────────────────────┘
```

## TypeScript-Specific Features

### Generic Clone Function

```typescript
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

// Maintains type information
const messages: Message[] = [...];
const cloned: Message[] = deepClone(messages);
```

### Type Predicates

```typescript
function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
    return block.type === "text";
}

// Usage
const textBlocks = content.filter(isTextBlock);
```

### Readonly Parameters

```typescript
async function spawnSubagent(
    prompt: string,
    context: readonly Message[]
): Promise<string> {
    // Cannot modify context array directly
    const cloned = deepClone(context);
    // ...
}
```

## Limitations

**Current Implementation**:
- Single-threaded execution
- Sequential subagent runs
- Shared process resources

**Future Improvements** (Sessions 8-11):
- Worker threads for parallelism
- Background task execution
- True isolation with worker processes

## Best Practices

1. **Deep clone** all context passed to subagents
2. **Limit context size** to prevent token overflow
3. **Extract summaries** from subagent responses
4. **Clean up** resources after subagent completes
5. **Log subagent** activities for debugging

## Troubleshooting

**Issue**: Subagent modifies main agent messages
- **Solution**: Ensure deep cloning, not shallow copy

**Issue**: Subagent loses context
- **Solution**: Pass sufficient context_length parameter

**Issue**: Subagent returns empty result
- **Solution**: Check for text blocks in response content

## Summary

Subagents enable parallel work by isolating contexts. TypeScript's type system ensures context cloning maintains type safety. Deep cloning prevents unintended side effects between main agent and subagents.

**Key Takeaways**:
- Deep clone for context isolation
- Type-safe context passing
- Extract summaries from responses
- Log subagent activities
- Prepare for worker thread integration
