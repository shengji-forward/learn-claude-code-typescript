# s10: Team Protocols

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > [ s10 ] s11 > s12`

> "Teammates need shared communication rules".

## Problem

s09 messaging is flexible but unstructured. Important flows like graceful shutdown and plan approval need deterministic request/response tracking.

## Solution

Use a shared `request_id` correlation pattern for protocol state.

```
request -> { request_id, payload }
response -> { request_id, approve/reject }
status -> pending -> approved | rejected
```

Apply that structure to:

- Shutdown requests
- Plan approval requests

## How It Works

1. Lead creates protocol request and stores state.

```typescript
const requestId = PROTOCOLS.createShutdownRequest("alice");
await BUS.send("lead", "alice", "Please shut down gracefully.", "shutdown_request", { request_id: requestId });
```

2. Teammate responds with the same `request_id`.

```typescript
await BUS.send("alice", "lead", "done", "shutdown_response", {
  request_id,
  approve: true,
});
```

3. Lead resolves protocol state.

```typescript
PROTOCOLS.updateShutdownStatus(requestId, true);
```

## What Changed From s09

| Component | s09 | s10 |
|---|---|---|
| Team messaging | free-form only | protocol-aware with trackers |
| Correlation | implicit | explicit `request_id` |
| Governance | ad hoc | pending/approved/rejected state machine |

## Try It

```sh
npm run s10
```

- Request shutdown for a teammate.
- Submit and review a teammate plan.
- Check protocol status through tool responses.
