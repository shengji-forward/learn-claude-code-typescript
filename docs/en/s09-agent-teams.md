# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"When the task is too big for one, delegate to teammates"* -- persistent teammates + async mailboxes.
>
> **Harness layer**: Team mailboxes -- multiple models, coordinated through files.

## Problem

Subagents (s04) are disposable: spawn, work, return summary, done. No identity between invocations. Background tasks (s08) run shell commands but are not full agent loops.

Real teamwork needs: (1) persistent agents that outlive a single prompt, (2) identity and lifecycle, (3) a communication channel.

## Solution

```
.team/
  config.json           <- roster + statuses
  inbox/
    alice.jsonl         <- append-only, drain-on-read
    bob.jsonl
```

Messages are JSON lines: `send` appends; `read_inbox` reads and drains.

## How It Works

1. **TeammateManager** maintains `config.json` with the team roster.

2. **spawn** starts a teammate loop (often in its own worker / thread in this implementation).

3. **MessageBus**: append-only JSONL inboxes per name.

4. Each teammate checks inbox before LLM calls and injects `<inbox>...</inbox>` user content when needed.

## Core TypeScript Shape

```typescript
const msg: TeamMessage = {
  type: msgType,
  from: sender,
  content,
  timestamp: Date.now() / 1000,
  ...extra,
};

await fs.appendFile(path.join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
```

```typescript
const content = await fs.readFile(inboxPath, "utf-8");
const lines = content.trim().split("\n");
const messages: TeamMessage[] = [];

for (const line of lines) {
  if (line) {
    messages.push(JSON.parse(line));
  }
}

await fs.writeFile(inboxPath, "", "utf-8");
```

## What Changed From s08

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Agents         | Single           | Lead + teammates           |
| Persistence    | Background ids   | Team config + JSONL inboxes|
| Communication  | Notifications    | Directed + broadcast mail  |

## Try It

```sh
npm run s09
```

1. `Spawn two teammates and pass a message between them`
2. `Broadcast a status update to the team`
3. `Use /team and /inbox style commands if exposed in the REPL`
