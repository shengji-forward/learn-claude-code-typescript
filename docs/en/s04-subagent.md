# s04: Subagents

`s01 > s02 > s03 > [ s04 ] s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"Break big tasks down; each subtask gets a clean context"* -- subagents use independent `messages[]`, keeping the main conversation clean.
>
> **Harness layer**: Context isolation -- protecting the model's clarity of thought.

## Problem

As the agent works, its messages array grows. Every file read, every bash output stays in context permanently. "What testing framework does this project use?" might require reading 5 files, but the parent only needs the answer: "vitest" or "jest".

## Solution

```
Parent agent                     Subagent
+------------------+             +------------------+
| messages=[...]   |             | messages=[]      | <-- fresh
|                  |  dispatch   |                  |
| tool: task       | ----------> | while tool_use:  |
|   prompt="..." |             |   call tools     |
|                  |  summary    |   append results |
|   result = "..." | <---------- | return last text |
+------------------+             +------------------+

Parent context stays clean. Subagent context is discarded.
```

## How It Works

1. The parent gets a `task` tool. The child gets all base tools except `task` (no recursive spawning).

```typescript
const PARENT_TOOLS: Tool[] = [...BASE_TOOLS, taskTool];
const CHILD_TOOLS: Tool[] = [...BASE_TOOLS];
```

2. The subagent starts with a fresh user message and runs its own loop. Only the final text returns to the parent.

```typescript
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Message[] = [{ role: "user", content: prompt }];
  await agentLoop(subMessages, CHILD_TOOLS);
  return extractText(subMessages);
}
```

3. The parent receives a summary as a normal `tool_result`.

```typescript
results.push({
  type: "tool_result",
  tool_use_id: block.id,
  content: subSummary,
});
```

The child's entire message history is discarded. The parent receives a concise summary.

## What Changed From s03

| Component      | Before (s03)     | After (s04)               |
|----------------|------------------|---------------------------|
| Tools          | 5                | 5 (base) + task (parent)  |
| Context        | Single shared    | Parent + child isolation  |
| Subagent       | None             | `runSubagent()`           |
| Return value   | N/A              | Summary text only         |

## Try It

```sh
npm run s04
```

1. `Use a subtask to find what testing framework this project uses`
2. `Delegate: read key config files and summarize`
3. `Use a task to draft a small module, then verify from the parent`
