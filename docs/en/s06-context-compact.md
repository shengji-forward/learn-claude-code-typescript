# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> "Context will fill up; you need a way to make room".

## Problem

Long sessions accumulate tool outputs and quickly approach model context limits. Without compaction, the agent eventually becomes unable to continue.

## Solution

Three layers of compaction:

1. Micro-compact old tool results each turn.
2. Auto-compact when token estimate crosses threshold.
3. Manual compact tool for explicit control.

```
each turn -> micro compact
if estimate > threshold -> auto compact
manual override -> compact tool
```

## How It Works

1. Lightweight compaction keeps recent detail and shrinks old tool payloads.

```typescript
function microCompact(messages: any[]): void {
  // replace old large tool_result content with short markers
}
```

2. Auto compact creates a summarized conversation state.

```typescript
if (estimateTokens(messages) > TOKEN_THRESHOLD) {
  messages = await autoCompact(messages);
}
```

3. Full transcripts are persisted before aggressive compaction.

```typescript
await fs.writeFile(transcriptPath, serializedMessages, "utf-8");
```

## What Changed From s05

| Component | s05 | s06 |
|---|---|---|
| Context strategy | none | 3-layer compaction pipeline |
| Persistence | optional | transcript snapshots for recovery |
| Tooling | base + skills | base + skills + `compact` |

## Try It

```sh
npm run s06
```

- Run a task that reads many large files.
- Observe token threshold behavior.
- Trigger manual compact and continue work.
