# s15: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 > s07 > s08 > s09 > s10 > s11 > s12 > s13 > s14 > [ s15 ] > s16 > s17 > s18 > s19`

> "When one agent is not enough, delegate to persistent teammates".
>
> **Harness layer**: Multi-agent orchestration -- teammates with async mailboxes.

## Problem

Subagents from s04 are ephemeral. They do one job, return, and disappear. For ongoing collaboration we need named teammates that can keep working, idle, receive messages, and resume.

## Solution

Persist team state in `.team/config.json` and communicate through JSONL inboxes.

```
.team/
  config.json
  inbox/
    lead.jsonl
    alice.jsonl
    bob.jsonl
```

Each teammate runs its own loop in a worker and reads its inbox between turns.

## How It Works

1. `TeammateManager` stores roster and status (`idle`, `working`, `shutdown`).

```typescript
await TEAMMATES.spawn("alice", "coder", "Implement auth module changes");
```

2. Message bus appends messages to recipient inbox files.

```typescript
await BUS.send("lead", "alice", "Please patch auth.ts", "message");
```

3. Teammates drain inbox content and continue their own loop.

```typescript
const inbox = await BUS.readInbox("alice");
messages.push({ role: "user", content: JSON.stringify(inbox) });
```

## What Changed From s08

| Component | s08 | s09 |
|---|---|---|
| Execution unit | one agent + background jobs | lead + persistent teammates |
| Coordination channel | none | JSONL inbox per teammate |
| Team state | transient | durable config + status |

## Try It

```sh
npm run s09
```

- Spawn two teammates with different roles.
- Send direct and broadcast messages.
- Inspect `/team` and `/inbox` behavior.
