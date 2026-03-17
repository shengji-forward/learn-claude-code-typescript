# s01: The Agent Loop

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> "One loop and bash is all you need" - one tool plus one loop gives you a working agent.

## Problem

An LLM can reason, but it cannot directly touch files, run commands, or inspect your workspace state. Without an execution loop, a human has to manually bridge every tool call.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> |  Tool   |
| prompt |      |       |      | execute |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                    (repeat until stop_reason != "tool_use")
```

The loop keeps running until the assistant stops requesting tools.

## How It Works

1. Start with a user message.

```typescript
messages.push({ role: "user", content: query });
```

2. Call the model with `messages` and `tools`.

```typescript
const response = await client.messages.create({
  model: MODEL,
  system: SYSTEM,
  messages,
  tools: TOOLS,
  max_tokens: 8000,
});
```

3. Append assistant output and exit when no tool call is requested.

```typescript
messages.push({ role: "assistant", content: response.content });
if (response.stop_reason !== "tool_use") return;
```

4. Execute each tool call, return `tool_result`, and continue.

```typescript
const results = [];
for (const block of response.content) {
  if (block.type !== "tool_use") continue;
  const output = await runBash(block.input.command);
  results.push({ type: "tool_result", tool_use_id: block.id, content: output });
}
messages.push({ role: "user", content: results });
```

## What Changed

| Component | Before | After |
|---|---|---|
| Tools | none | `bash` |
| Control flow | none | `while` loop with `stop_reason` gate |
| Conversation state | none | persistent `messages[]` |

## Try It

```sh
npm run s01
```

- Create `hello.ts` and verify content.
- Ask for current git branch.
- Run a small command and confirm output.
