# s12: Task System

`s01 > s02 > s03 > s04 > s05 > s06 > s07 > s08 > s09 > s10 > s11 > [ s12 ] > s13 > s14 > s15 > s16 > s17 > s18 > s19`

> "Break big goals into small tasks, order them, persist to disk".
>
> **Harness layer**: Persistent goals -- task graph that survives beyond single conversations.

## Problem

A flat in-memory checklist cannot model dependencies, parallelism, or restart safety. Team coordination needs durable task state and explicit dependency edges.

## Solution

Create a disk-backed task graph where each task is a JSON file in `.tasks/`.

```
.tasks/
  task_1.json
  task_2.json
  ...

status: pending -> in_progress -> completed
blockedBy: [task ids]
```

## How It Works

1. `TaskManager` owns CRUD and ID sequencing.

```typescript
class TaskManager {
  async create(subject: string, description = ""): Promise<string> {
    // write task_N.json
  }
}
```

2. Dependencies are represented explicitly.

```typescript
interface Task {
  id: number;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
}
```

3. Task tools expose control-plane operations.

```typescript
TOOL_HANDLERS.task_create = async (input) => TASKS.create(input.subject, input.description);
TOOL_HANDLERS.task_update = async (input) => TASKS.update(input.task_id, input.status, input.owner);
TOOL_HANDLERS.task_list = async () => TASKS.listAll();
TOOL_HANDLERS.task_get = async (input) => TASKS.get(input.task_id);
```

## What Changed From s06

| Component | s06 | s07 |
|---|---|---|
| Planning substrate | in-message todo state | file-backed task graph |
| Persistence | transcript snapshots | durable task records |
| Coordination info | implicit | explicit status + dependencies |

## Try It

```sh
npm run s07
```

- Create multiple tasks with dependencies.
- Mark a prerequisite completed.
- Confirm blocked tasks become actionable.
