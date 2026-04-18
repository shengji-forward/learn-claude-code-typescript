# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"An agent without a plan drifts"* -- list the steps first, then execute.
>
> **Harness layer**: Planning -- keeping the model on course without scripting the route.

## Problem

On multi-step tasks, the model loses track. It repeats work, skips steps, or wanders off. Long conversations make this worse -- the system prompt fades as tool results fill the context. A 10-step refactoring might complete steps 1-3, then the model starts improvising because it forgot steps 4-10.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if rounds_since_todo >= 3:
                append <reminder> after tool_results
```

## How It Works

1. TodoManager stores items with statuses. Only one item can be `in_progress` at a time.

```typescript
class TodoManager {
  update(items: TodoItem[]): string {
    const inProgress = items.filter((i) => i.status === "in_progress").length;
    if (inProgress > 1) throw new Error("Only one in_progress task is allowed");
    this.items = items;
    return this.render();
  }
}
```

2. The `todo` tool goes into the dispatch map like any other tool.

```typescript
TOOL_HANDLERS.todo = async (input) => TODO.update(input.items);
```

3. A nag reminder appends a nudge if the model goes 3+ rounds without calling `todo` (after `tool_result` blocks so the model sees tool output first on the next turn).

```typescript
roundsSinceTodo.value = todoUsed ? 0 : roundsSinceTodo.value + 1;
if (roundsSinceTodo.value >= 3) {
  results.push({
    type: "text",
    text: "<reminder>Update your todos.</reminder>",
  });
}
messages.push({ role: "user", content: results });
```

The "one in_progress at a time" constraint forces sequential focus. The nag reminder creates accountability.

## What Changed From s02

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + roundsSinceTodo counter  |

## Try It

```sh
npm run s03
```

1. `Refactor a small file: add type hints, docstrings, and a main guard`
2. `Create a package layout with utils and a test file`
3. `Review TypeScript files and fix any style issues`
