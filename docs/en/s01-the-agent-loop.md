# s01: The Agent Loop

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> "One loop and bash is all you need" - one tool plus one loop gives you a working agent.
>
> **Harness layer**: The loop -- the model's first connection to the real world.

## Problem

A language model can reason about code, but it can't *touch* the real world -- can't read files, run tests, or check errors. Without a loop, every tool call requires you to manually copy-paste results back. You become the loop.

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

One exit condition controls the entire flow. The loop runs until the model stops calling tools.

## How It Works

1. Start with a user message.

```typescript
messages.push({ role: "user", content: query });
```

1. Call the model with `messages` and `tools`.

```typescript
const response = await client.messages.create({
  model: MODEL,
  system: SYSTEM,
  messages,
  tools: TOOLS,
  max_tokens: 8000,
});
```

1. Append assistant output and exit when no tool call is requested.

```typescript
messages.push({ role: "assistant", content: response.content });
if (response.stop_reason !== "tool_use") return;
```

1. Execute each tool call, return `tool_result`, and continue.

```typescript
const results = [];
for (const block of response.content) {
  if (block.type !== "tool_use") continue;
  const output = await runBash(block.input.command);
  results.push({ type: "tool_result", tool_use_id: block.id, content: output });
}
messages.push({ role: "user", content: results });
```

---

**Assembled into one function:**

```typescript
// Assembled into one function:
function agentLoop(query: string) {
    const messages = [{ role: "user", content: query }];
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens: 8000,
        });
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const output = await runBash(block.input["command"]);
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
        }
        messages.push({ role: "user", content: results });
    }
}
```

That's the entire agent in under 30 lines. Everything else in this course layers on top -- without changing the loop.

## What Changed

| Component     | Before     | After                          |
|---------------|------------|--------------------------------|
| Agent loop    | (none)     | `while True` + stop_reason     |
| Tools         | (none)     | `bash` (one tool)              |
| Messages      | (none)     | Accumulating list              |
| Control flow  | (none)     | `stop_reason != "tool_use"`    |


## Try It

```sh
npm run s01
```

1. `Create a file called hello.ts that prints "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`

