# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- daemon threads run commands, inject notifications on completion.
>
> **Harness layer**: Background execution -- the model thinks while the harness waits.

## Problem

Some commands take minutes: `npm install`, test runs, builds. With a blocking loop, the model sits idle. You want to start long work and keep reasoning in parallel.

## Solution

```
Main thread                Background work
+-----------------+        +-----------------+
| agent loop      |        | subprocess /    |
| ...             |        | worker runs     |
| drain notifs    | <----- | enqueue result  |
+-----------------+        +-----------------+
```

## How It Works

1. A background manager tracks tasks and a notification queue.

2. Starting work returns immediately with an id; completion enqueues a notification.

3. Before each LLM call, the loop drains notifications and injects them into `messages` (for example as a user message with a `<background-results>` wrapper).

The loop stays structured as a single conversational thread; only execution is parallelized.

## Core TypeScript Shape

```typescript
const taskId = this.generateTaskId();
this.tasks.set(taskId, { status: TaskStatus.RUNNING, result: null, command });

const worker = new Worker(workerPath, {
  workerData: { taskId, command, workdir: WORKDIR, timeout: 300000 },
  ...(workerPath.endsWith(".ts") ? { execArgv: ["--loader", "ts-node/esm"] } : {}),
});
```

```typescript
drainNotifications(): Notification[] {
  const notifs = [...this.notificationQueue];
  this.notificationQueue = [];
  return notifs;
}
```

## What Changed From s07

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | + `background_run` + `check_background` |
| Execution      | Blocking only    | Background + drain queue   |
| Notification   | None             | Injected before model call |

## Try It

```sh
npm run s08
```

1. `Run a short sleep in the background, then do something else while it finishes`
2. `Start multiple background commands and check their status`
3. `Run tests in the background and keep working`
