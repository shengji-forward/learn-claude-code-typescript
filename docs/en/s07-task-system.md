# s07: Task System

`s01 > s02 > s03 > s04 > s05 > s06 | [ s07 ] s08 > s09 > s10 > s11 > s12`

> *"Break big goals into small tasks, order them, persist to disk"* -- a file-based task graph with dependencies, laying the foundation for multi-agent collaboration.
>
> **Harness layer**: Persistent tasks -- goals that outlive any single conversation.

## Problem

s03's TodoManager is a flat checklist in memory: no ordering, no dependencies, no status beyond done-or-not. Real goals have structure -- task B depends on task A, tasks C and D can run in parallel, task E waits on both C and D.

Without explicit relationships, the agent can't tell what's ready, what's blocked, or what can run concurrently. And because the list lives only in memory, context compression (s06) wipes it clean.

## Solution

Promote the checklist into a **task graph** persisted to disk. Each task is a JSON file with status and dependencies (`blockedBy`). The graph answers three questions at any moment:

- **What's ready?** -- tasks with `pending` status and empty `blockedBy`.
- **What's blocked?** -- tasks waiting on unfinished dependencies.
- **What's done?** -- `completed` tasks, whose completion automatically unblocks dependents.

```
.tasks/
  task_1.json  {"id":1, "status":"completed"}
  task_2.json  {"id":2, "blockedBy":[1], "status":"pending"}
  ...
```

This task graph becomes the coordination backbone for everything after s07: background execution (s08), multi-agent teams (s09+), and worktree isolation (s12) all read from and write to this same structure.

## How It Works

1. **TaskManager**: one JSON file per task, CRUD with dependency graph.

```typescript
class TaskManager {
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.nextId = (await this.maxId()) + 1;
  }

  async create(input: TaskCreateInput): Promise<string> {
    const task: Task = {
      id: this.nextId++,
      subject: input.subject,
      description: input.description ?? "",
      status: TaskStatus.PENDING,
      blockedBy: [],
      owner: "",
    };
    await this.save(task);
    return JSON.stringify(task, null, 2);
  }
}
```

2. **Dependency resolution**: completing a task clears its ID from every other task's `blockedBy` list.

3. **Status + dependency wiring**: `update` handles transitions and dependency edges (`addBlockedBy` / `removeBlockedBy`).

4. Task tools (`task_create`, `task_update`, `task_list`, `task_get`) register in the dispatch map like other tools.

From s07 onward, the task graph is the default for multi-step work. s03's Todo remains for quick single-session checklists.

## What Changed From s06

| Component | Before (s06) | After (s07) |
|---|---|---|
| Tools | 5 | 8 (`task_create` / `task_update` / `task_list` / `task_get`) |
| Planning model | Flat checklist (in-memory) | Task graph with dependencies (on disk) |
| Relationships | None | `blockedBy` edges |
| Persistence | Lost on compression | Survives compression and restarts |

## Try It

```sh
npm run s07
```

1. `Create 3 dependent tasks and list them`
2. `Complete task 1 and list again to see dependents unblocked`
3. `Sketch a small refactor pipeline with parallel branches after a shared first step`
