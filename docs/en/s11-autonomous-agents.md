# s11: Autonomous Agents

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > [ s11 ] s12`

> *"Teammates scan the board and claim tasks themselves"* -- no need for the lead to assign each one.
>
> **Harness layer**: Autonomy -- models that find work without being told.

## Problem

In s09-s10, teammates only advance when explicitly driven. True autonomy means scanning the task board for ready work and claiming it safely -- including avoiding races when two teammates try to claim the same task.

## Solution

```
WORK -> IDLE -> poll inbox / scan tasks -> claim -> WORK
                      |
                      +-- timeout -> shutdown
```

Identity may be re-injected when context is very short after compression so the model remembers its role.

## How It Works

1. After a work phase, a teammate enters **idle** and polls on an interval up to a timeout.

2. **Idle** checks inbox first, then scans `.tasks/` for pending, unowned, unblocked work and attempts **claim** (with coordination so claims stay consistent).

3. Tools such as `idle` and `claim_task` participate in the policy surface exposed to the model.

## Core TypeScript Shape

```typescript
const acquireLock = async (): Promise<void> => {
  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.close();
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      await sleep(20);
    }
  }
};
```

```typescript
await acquireLock();
try {
  task.owner = owner;
  task.status = TaskStatus.IN_PROGRESS;
  await fs.writeFile(taskPath, JSON.stringify(task, null, 2), "utf-8");
} finally {
  try { await fs.unlink(lockPath); } catch {}
}
```

## What Changed From s10

| Component      | Before (s10)     | After (s11)                |
|----------------|------------------|----------------------------|
| Autonomy       | Lead-directed    | Self-scan + claim          |
| Idle phase     | None             | Poll inbox + task board    |
| Task claiming  | Manual only      | Auto-claim ready tasks     |

## Try It

```sh
npm run s11
```

1. `Create several tasks, spawn teammates, watch claims`
2. `Create dependent tasks and observe ordering`
3. `Use /tasks and /team if available in the REPL`
