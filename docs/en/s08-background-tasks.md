# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> "Run slow operations in the background; the agent keeps thinking".
>
> **Harness layer**: Parallelism -- non-blocking execution while the agent keeps thinking.

## Problem

Long-running commands block the main loop and waste time. We need concurrent execution for operations like test runs and large builds.

## Solution

Use worker threads for background commands and inject completion notifications back into the main loop.

```
main loop -> spawn background task -> continue foreground work
background worker -> completes -> queue notification -> next loop turn consumes it
```

## How It Works

1. `BackgroundManager` starts a worker and returns task ID immediately.

```typescript
const id = await BACKGROUND.run("npm test -- --runInBand");
```

2. Worker executes command with timeout and reports result.

```typescript
worker.on("message", (msg) => {
  notifications.push(msg);
});
```

3. Agent loop drains notifications before model call.

```typescript
const ready = BACKGROUND.drainNotifications();
if (ready.length > 0) {
  messages.push({ role: "user", content: formatBackgroundResults(ready) });
}
```

## What Changed From s07

| Component | s07 | s08 |
|---|---|---|
| Execution style | blocking | foreground + background lanes |
| Runtime signals | direct tool output | queued completion notifications |
| Concurrency | none | worker-based async execution |

## Try It

```sh
npm run s08
```

- Start one long test command in background.
- Do file edits while it runs.
- Confirm notification arrives with completion output.
