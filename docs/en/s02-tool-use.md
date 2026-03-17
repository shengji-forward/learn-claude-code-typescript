# s02: Tool Use

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> "Adding a tool means adding one handler" - the loop stays unchanged.

## Problem

Using only `bash` works, but file operations become noisy and less constrained. We want clearer contracts like `read_file`, `write_file`, and `edit_file` without changing the core loop.

## Solution

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | { name -> fn }   |
+--------+      +---+---+      +--------+---------+
                    ^                    |
                    +---- tool_result ---+
```

A dispatch map routes tool names to handler functions.

## How It Works

1. Keep file access inside workspace boundaries.

```typescript
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}
```

2. Register handlers in one object.

```typescript
const TOOL_HANDLERS: Record<string, (input: any) => Promise<string>> = {
  bash: async (input) => runBash(input.command),
  read_file: async (input) => runRead(input.path, input.limit),
  write_file: async (input) => runWrite(input.path, input.content),
  edit_file: async (input) => runEdit(input.path, input.old_text, input.new_text),
};
```

3. Tool execution is just a lookup.

```typescript
const handler = TOOL_HANDLERS[block.name];
const output = handler ? await handler(block.input) : `Unknown tool: ${block.name}`;
```

## What Changed From s01

| Component | s01 | s02 |
|---|---|---|
| Tool count | 1 | 4 |
| Routing | direct call | dispatch map |
| Path safety | implicit | explicit `safePath()` |
| Agent loop | unchanged | unchanged |

## Try It

```sh
npm run s02
```

- Read a source file with `read_file`.
- Modify it with `edit_file`.
- Re-read to validate the change.
