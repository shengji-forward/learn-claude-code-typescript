# s02: Tool Use

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"Adding a tool means adding one handler"* -- the loop stays the same; new tools register into the dispatch map.
>
> **Harness layer**: Tool dispatch -- expanding what the model can reach.

## Problem

With only `bash`, the agent shells out for everything. `cat` truncates unpredictably, `sed` fails on special characters, and every bash call is an unconstrained security surface. Dedicated tools like `read_file` and `write_file` let you enforce path sandboxing at the tool level.

The key insight: adding tools does not require changing the loop.

## Solution

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | {                |
+--------+      +---+---+      |   bash: run_bash |
                    ^           |   read: run_read |
                    |           |   write: run_wr  |
                    +-----------+   edit: run_edit |
                    tool_result | }                |
                                +------------------+

The dispatch map is a dict: {tool_name: handler_function}.
One lookup replaces any if/elif chain.
```

## How It Works

1. Each tool gets a handler function. Path sandboxing prevents workspace escape.

```typescript
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}
```

2. The dispatch map links tool names to handlers.

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (input) => {
    const command = input.command as string;
    return runBash(command);
  },
  read_file: async (input) => {
    const filePath = input.path as string;
    const limit = input.limit as number | undefined;
    return runRead(filePath, limit);
  },
  write_file: async (input) => {
    return runWrite(input.path as string, input.content as string);
  },
  edit_file: async (input) => {
    return runEdit(
      input.path as string,
      input.old_text as string,
      input.new_text as string,
    );
  },
};
```

3. In the loop, look up the handler by name. The loop body itself is unchanged from s01.

```typescript
const handler = TOOL_HANDLERS[block.name];
let output: string;
if (handler) {
  output = await handler(block.input);
} else {
  output = `Unknown tool: ${block.name}`;
}
```

Add a tool = add a handler + add a schema entry. The loop never changes.

## What Changed From s01

| Component      | Before (s01)       | After (s02)                |
|----------------|--------------------|----------------------------|
| Tools          | 1 (bash only)      | 4 (bash, read, write, edit)|
| Dispatch       | Hardcoded bash call | `TOOL_HANDLERS` map      |
| Path safety    | None               | `safePath()` sandbox       |
| Agent loop     | Unchanged          | Unchanged                  |

## Try It

```sh
npm run s02
```

1. `Read the file package.json`
2. `Create a file called greet.ts with a greet(name) function`
3. `Edit greet.ts to add a docstring to the function`
4. `Read greet.ts to verify the edit worked`
