# s03: TodoWrite

`s01 > s02 > [ s03 ] > s04 > s05 > s06 > s07 > s08 > s09 > s10 > s11 > s12 > s13 > s14 > s15 > s16 > s17 > s18 > s19`

> "An agent without a plan drifts" - list the steps first, then execute.
>
> **Harness layer**: Planning -- keeping the model on course without scripting the route.

## Problem

For multi-step work, the model can lose sequencing, skip checks, or repeat tasks. We need visible progress state that the model updates while it works.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    +---- tool_result+
                         |
               +---------+----------+
               | Todo state         |
               | [ ] pending        |
               | [>] in_progress    |
               | [x] completed      |
               +--------------------+
```

## How It Works

1. `TodoManager` validates and renders task list state.

```typescript
class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    const inProgress = items.filter((i) => i.status === "in_progress").length;
    if (inProgress > 1) throw new Error("Only one in_progress task is allowed");
    this.items = items;
    return this.render();
  }
}
```

2. Expose it as a normal tool.

```typescript
TOOL_HANDLERS.todo = async (input) => TODO.update(input.items);
```

3. Add a reminder when the model avoids todo updates for multiple turns.

```typescript
if (roundsSinceTodo >= 3) {
  results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
}
```

## What Changed From s02

| Component | s02 | s03 |
|---|---|---|
| Planning state | none | explicit todo list |
| Tooling | file + bash tools | file + bash + `todo` |
| Loop behavior | pure dispatch | dispatch + reminder counter |

## Try It

```sh
npm run s03
```

- Give a multi-step refactor task.
- Watch `todo` updates track execution order.
- Confirm final list is fully completed.
