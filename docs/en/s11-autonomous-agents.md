# s11: Autonomous Agents

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > [ s11 ] s12`

> "Teammates should find work themselves".
>
> **Harness layer**: Self-organization -- idle polling and automatic task claiming.

## Problem

In s10 the lead still drives assignment. For larger workloads, teammates should pull from a shared board when idle and continue without direct prompts.

## Solution

Add an idle cycle where each teammate:

1. Polls inbox for messages.
2. Scans task board for unclaimed work.
3. Claims and resumes execution automatically.
4. Shuts down after idle timeout.

## How It Works

1. Teammate loop alternates between work and idle phases.

```typescript
while (true) {
  await workPhase();
  const resumed = await idlePhase();
  if (!resumed) break;
}
```

2. Idle phase scans `.tasks/` for claimable tasks.

```typescript
const unclaimed = await TASKS.scanUnclaimedTasks();
if (unclaimed.length > 0) {
  await TASKS.claimTask(unclaimed[0].id, teammateName);
}
```

3. Identity is re-injected after heavy compression to preserve teammate role.

```typescript
messages.unshift(makeIdentityBlock(name, role, teamName));
```

## What Changed From s10

| Component | s10 | s11 |
|---|---|---|
| Task pickup | lead-assigned | teammate auto-claim |
| Idle behavior | passive | polling + timeout |
| Continuity | implicit | explicit identity re-injection |

## Try It

```sh
npm run s11
```

- Create unowned tasks in `.tasks/`.
- Spawn autonomous teammates.
- Watch claims happen without manual assignment.
