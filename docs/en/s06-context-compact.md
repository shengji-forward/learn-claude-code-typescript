# Session 6: Context Compact

## Overview

This session introduces context compression to manage token limits. Learn how to compress conversation history while preserving important information, enabling agents to handle long-running conversations.

### What You'll Learn

- **Token Management**: Track and manage token usage
- **Compression Strategies**: Remove redundant information
- **Microcompaction**: Quick compression between turns
- **Auto-compact**: Aggressive compression when needed
- **Context Preservation**: Keep critical information

## Running the Session

```bash
npm run s06
# or
ts-node agents/s06_context_compact.ts
```

## Key Implementation Details

### TypeScript vs Python

**Token Counting**:
- **Python**: `len(encoding.encode(text))`
- **TypeScript**: Approximate with `text.length / 4`
- **Why**: TypeScript lacks built-in tokenizer

**Array Manipulation**:
- **Python**: List slicing and comprehensions
- **TypeScript**: Array methods with type safety
- **Why**: Type-safe array operations

**Compression Logic**:
- **Python**: Complex list manipulation
- **TypeScript**: Functional array methods
- **Why**: Immutable operations with better typing

## Code Examples

### Token Counter

```typescript
function estimateTokens(text: string): number {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
}

function countMessagesTokens(messages: Message[]): number {
    return messages.reduce((total, message) => {
        const content = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        return total + estimateTokens(content);
    }, 0);
}
```

### Microcompact Function

```typescript
function microcompact(messages: Message[]): Message[] {
    if (messages.length <= 6) return messages;

    // Keep first 2 (system prompt + initial user message)
    // Keep last 4 (recent conversation)
    return [
        messages[0],
        messages[1],
        ...messages.slice(-4)
    ];
}
```

### Auto-compact Function

```typescript
function autoCompact(messages: Message[], targetTokens: number): Message[] {
    let currentTokens = countMessagesTokens(messages);

    if (currentTokens <= targetTokens) {
        return messages;
    }

    console.log(`🗜️  Compressing context: ${currentTokens} → ${targetTokens} tokens`);

    // Keep system prompt
    const compacted: Message[] = [messages[0]];

    // Keep summary of middle messages
    if (messages.length > 4) {
        const middleMessages = messages.slice(1, -3);
        const summary = summarizeMessages(middleMessages);
        compacted.push({
            role: "user",
            content: `[Previous conversation summary: ${summary}]`
        });
    }

    // Keep recent messages
    compacted.push(...messages.slice(-3));

    return compacted;
}

function summarizeMessages(messages: Message[]): string {
    const toolUses = messages.flatMap(m =>
        typeof m.content === "string" ? [] :
        m.content.filter(c => c.type === "tool_use")
    );
    const taskCount = toolUses.length;

    return `Completed ${taskCount} tasks across ${messages.length} message exchanges`;
}
```

### Compress Tool Handler

```typescript
const TOKEN_THRESHOLD = 100000;

const compressHandler: ToolHandler = async (input: unknown) => {
    const { target_tokens } = input as { target_tokens?: number };
    const target = target_tokens || TOKEN_THRESHOLD;

    const beforeCount = messages.length;
    messages = autoCompact(messages, target);
    const afterCount = messages.length;

    const tokensSaved = countMessagesTokens(messages.slice(0, beforeCount - afterCount));

    return `Compressed context: ${beforeCount} → ${afterCount} messages (~${tokensSaved} tokens saved)`;
};
```

### Integration in Agent Loop

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        // Microcompact between turns
        messages = microcompact(messages);

        // Check if we need aggressive compression
        const currentTokens = countMessagesTokens(messages);
        if (currentTokens > TOKEN_THRESHOLD) {
            console.log("⚠️  Context size approaching limit, auto-compacting...");
            messages = autoCompact(messages, TOKEN_THRESHOLD * 0.8);
        }

        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 8000,
            messages: messages,
        });

        // ... rest of agent loop
    }
}
```

## Architecture

```
┌─────────────────────────────────────────┐
│        Context Compression              │
├─────────────────────────────────────────┤
│  1. Count tokens in messages            │
│  2. Compare to threshold                │
│  3. If over limit:                      │
│     - Keep system prompt                │
│     - Summarize middle messages         │
│     - Keep recent messages              │
│  4. Return compressed messages          │
└─────────────────────────────────────────┘
```

## Compression Strategies

### Strategy 1: Keep System + Recent

```typescript
function keepSystemAndRecent(messages: Message[]): Message[] {
    return [
        messages[0],  // System prompt
        ...messages.slice(-5)  // Last 5 messages
    ];
}
```

### Strategy 2: Summarize Middle

```typescript
function summarizeMiddle(messages: Message[]): Message[] {
    const system = messages[0];
    const recent = messages.slice(-3);
    const middle = messages.slice(1, -3);

    const summary = createSummary(middle);

    return [
        system,
        { role: "user", content: summary },
        ...recent
    ];
}
```

### Strategy 3: Keep Tool Results

```typescript
function keepToolResults(messages: Message[]): Message[] {
    return messages.filter(msg => {
        const content = msg.content as ContentBlock[];
        return content.some(block =>
            block.type === "tool_result" ||
            block.type === "text"
        );
    });
}
```

## TypeScript-Specific Features

### Type Predicates for Content Blocks

```typescript
function isToolUse(block: ContentBlock): block is ToolUseBlock {
    return block.type === "tool_use";
}

function isText(block: ContentBlock): block is { type: "text"; text: string } {
    return block.type === "text";
}
```

### Immutable Array Operations

```typescript
// Instead of mutating original array
function compressImmutable(messages: readonly Message[]): Message[] {
    return [
        messages[0],
        ...messages.slice(-3)
    ];
}
```

### Readonly Parameters

```typescript
function countTokens(messages: readonly Message[]): number {
    // Cannot modify messages inside function
    return messages.reduce((total, msg) => {
        return total + estimateTokens(JSON.stringify(msg));
    }, 0);
}
```

## Best Practices

1. **Compress conservatively** - Keep important context
2. **Monitor token usage** - Compress before hitting limits
3. **Preserve system prompt** - Never remove it
4. **Keep recent history** - Maintain conversation flow
5. **Summarize intelligently** - Capture key information
6. **Log compression** - Track when and how much is compressed
7. **Test compression** - Verify agent still works correctly

## Troubleshooting

**Issue**: Agent loses important context
- **Solution**: Adjust compression to keep more messages

**Issue**: Compression happens too frequently
- **Solution**: Increase TOKEN_THRESHOLD value

**Issue**: Agent behavior changes after compression
- **Solution**: Improve summarization to capture key info

## Summary

Context compression enables long-running conversations by managing token limits. TypeScript's type system ensures message structure is preserved during compression. Multiple strategies balance context preservation with token efficiency.

**Key Takeaways**:
- Estimate tokens with character count
- Microcompact between turns
- Auto-compact when approaching limits
- Preserve system prompt and recent messages
- Summarize middle conversations
- Monitor compression impact
