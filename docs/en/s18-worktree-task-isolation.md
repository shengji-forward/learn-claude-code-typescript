# s18: Worktree + Task Isolation

`s01 > s02 > s03 > s04 > s05 > s06 > s07 > s08 > s09 > s10 > s11 > s12 > s13 > s14 > s15 > s16 > s17 > [ s18 ] > s19`

> "Coordinate by task ID, isolate by directory".
>
> **Harness layer**: Parallel execution lanes -- isolated workspaces bound by task IDs.

## Problem

By s11, multiple agents can work concurrently, but shared workspace edits still collide. Task ownership alone is not enough; execution paths must be isolated too.

## Solution

Split responsibility into two planes:

- Control plane: `.tasks/` for canonical task state.
- Execution plane: `.worktrees/` for isolated git worktree directories.

```
.tasks/task_1.json   <->   .worktrees/auth-refactor/
.tasks/task_2.json   <->   .worktrees/ui-login/

index.json tracks worktree lifecycle
events.jsonl records lifecycle transitions
```

## How It Works

1. Detect repo root first and initialize managers with deterministic paths.

```typescript
const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;
const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);
```

2. Bind task and worktree state explicitly.

```typescript
await WORKTREES.create("auth-refactor", 1, "HEAD");
// task #1 becomes in_progress and stores worktree binding
```

3. Route commands by lane name, not shared cwd.

```typescript
await WORKTREES.run("auth-refactor", "npm test -- auth");
```

4. Close out with keep/remove and optional task completion.

```typescript
await WORKTREES.keep("ui-login");
await WORKTREES.remove("auth-refactor", false, true);
```

## What Changed From s11

| Component | s11 | s12 |
|---|---|---|
| Coordination scope | shared task board only | shared board + isolated worktree lanes |
| Execution cwd | shared workspace | lane-specific worktree path |
| Lifecycle visibility | implicit logs | structured events in `events.jsonl` |

## Try It

```sh
npm run s12
```

- Create two tasks.
- Allocate separate worktrees and run commands in each lane.
- Keep one lane and remove the other with `complete_task=true`.
