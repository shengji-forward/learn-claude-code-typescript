# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"Context will fill up; you need a way to make room"* -- three-layer compression strategy for infinite sessions.
>
> **Harness layer**: Compression -- clean memory for infinite sessions.

## Problem

The context window is finite. A single `read_file` on a large file costs many tokens. After reading many files and running many commands, you approach model limits. The agent cannot work on large codebases without compression.

## Solution

Three layers, increasing in aggressiveness:

```
Every turn:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Layer 1: micro_compact]        (silent, every turn)
  Replace old tool_result content
  (skips preserving read_file payloads)
        |
        v
[Check: tokens > threshold?]
   |               |
   no              yes
   |               |
   v               v
continue    [Layer 2: auto_compact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace messages with summary.
                    |
                    v
            [Layer 3: compact tool]
              Model calls compact explicitly.
              Same summarization as auto_compact.
```

## How It Works

1. **Layer 1 -- micro_compact**: Before each LLM call, replace old tool results with placeholders; optionally preserve `read_file` results as reference material.

```typescript
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);
// ...
if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
result.content = `[Previous: used ${toolName}]`;
```

2. **Layer 2 -- auto_compact**: When tokens exceed threshold, save full transcript to disk, then ask the LLM to summarize. Summary text is assembled from **all** text blocks in the response (not only the first block).

```typescript
async function autoCompact(messages: Message[]): Promise<Message[]> {
  await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  await fs.writeFile(transcriptPath, /* jsonl of messages */, "utf-8");
  const summaryResponse = await client.messages.create({ /* ... */ });
  const summary = summaryResponse.content
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();
  return [{ role: "user", content: `[Conversation compressed...]\n\n${summary}` }];
}
```

3. **Layer 3 -- manual compact**: The `compact` tool triggers the same summarization on demand.

4. The loop integrates all three: `microCompact(messages)` before each model call; `autoCompact` when estimated tokens exceed the threshold; `compact` tool when the model asks.

Transcripts preserve full history on disk. Nothing is truly lost -- just moved out of active context.

## What Changed From s05

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to `.transcripts/`   |

## Try It

```sh
npm run s06
```

1. `Read several source files one by one` (watch micro-compact replace old results)
2. `Keep reading until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`
