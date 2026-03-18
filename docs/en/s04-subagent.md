# s04: Subagents

`s01 > s02 > s03 > [ s04 ] s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> "Break big tasks down; each subtask gets a clean context".
>
> **Harness layer**: Context isolation -- protecting the model's clarity of thought.

## Problem

A single growing context can mix unrelated details. When one subtask is independent, forcing it into the same message history increases noise and confusion.

## Solution

```
Parent context                  Child context
+------------------+            +------------------+
| messages=[...]   |            | messages=[]      |
| call task tool   | ---------> | run loop         |
| continue work    | <--------- | return summary   |
+------------------+            +------------------+
```

The child gets isolated context and returns only concise results.

## How It Works

1. Parent has a `task` tool; child does not (no recursive spawning by default).

```typescript
const PARENT_TOOLS = [...BASE_TOOLS, taskTool];
const CHILD_TOOLS = [...BASE_TOOLS];
```

2. Spawn subagent loop with fresh messages.

```typescript
async function runSubagent(prompt: string): Promise<string> {
  const subMessages = [{ role: "user", content: prompt }];
  await agentLoop(subMessages, CHILD_TOOLS);
  return extractText(subMessages);
}
```

3. Parent receives summary as `tool_result` and keeps going.

```typescript
results.push({ type: "tool_result", tool_use_id: block.id, content: subSummary });
```

## What Changed From s03

| Component | s03 | s04 |
|---|---|---|
| Context model | single thread | parent + isolated child |
| Delegation | none | `task` tool |
| Return value | direct tool outputs | summarized child result |

## Try It

```sh
npm run s04
```

- Delegate test generation to a subagent.
- Keep main agent focused on structural refactor.
- Verify parent context remains concise.
