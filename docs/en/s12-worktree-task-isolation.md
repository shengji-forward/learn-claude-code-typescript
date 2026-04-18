# s12: Worktree + Task Isolation

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > [ s12 ]`

> *"Each works in its own directory, no interference"* -- tasks manage goals, worktrees manage directories, bound by ID.
>
> **Harness layer**: Directory isolation -- parallel execution lanes that never collide.

## Problem

By s11, agents can claim tasks, but everything shares one working tree. Parallel refactors collide in the same files. The task board tracks *what* to do but not *where* safely.

## Solution

Pair each running task with an optional git worktree under a managed directory (for example `.worktrees/`). Commands run with `cwd` in that lane; lifecycle events append to an `events.jsonl` log.

```
.tasks/task_1.json  <-->  .worktrees/<name>/  (branch + path)
```

## How It Works

1. **Create tasks** in `.tasks/` as in s07.

2. **Create / bind worktrees** with tools that invoke `git worktree` and record the binding on the task record.

3. **Run** shell/file tools with paths rooted in the worktree when a task is bound.

4. **Keep or remove** worktrees; removing can optionally complete the bound task and emit events.

## Core TypeScript Shape

```typescript
await this.runGit(["worktree", "add", "-b", branch, worktreePath, baseRef]);

const worktree: Worktree = {
  name,
  path: worktreePath,
  branch,
  task_id: taskId,
  status: WorktreeStatus.ACTIVE,
  created_at: Date.now() / 1000,
};
```

```typescript
if (taskId !== undefined) {
  await this.tasks.bindWorktree(taskId, name);
}

await this.events.emit(
  "worktree.create.after",
  taskId !== undefined ? { id: taskId } : {},
  { name, path: worktreePath, branch, status: "active" }
);
```

## What Changed From s11

| Component          | Before (s11)               | After (s12)                                  |
|--------------------|----------------------------|----------------------------------------------|
| Execution scope    | Shared directory           | Optional isolated worktree per task         |
| Recoverability     | Task status                | Task + worktree registry + events           |

## Try It

```sh
npm run s12
```

1. `Create tasks, then create worktrees bound to them`
2. `Run git status inside a named worktree`
3. `Keep one worktree and remove another, then inspect tasks and events`
