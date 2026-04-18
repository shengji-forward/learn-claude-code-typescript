# s10: Team Protocols

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > [ s10 ] s11 > s12`

> *"Teammates need shared communication rules"* -- one request-response pattern drives all negotiation.
>
> **Harness layer**: Protocols -- structured handshakes between models.

## Problem

In s09, teammates communicate but lack structured coordination for risky operations: graceful shutdown and plan review before execution.

Both share the same shape: request with a unique id, response referencing the same id.

## Solution

- **Shutdown**: lead requests shutdown with `request_id`; teammate responds approve/reject.
- **Plan approval**: teammate submits a plan with `request_id`; lead responds approve/reject.

Shared state tracks `pending -> approved | rejected`.

## How It Works

1. Valid message types include `shutdown_request`, `shutdown_response`, `plan_approval_response`, etc.

2. Tools implement the handshake; the inbox carries structured JSON payloads.

3. One FSM pattern, two applications -- correlation via `request_id`.

## Core TypeScript Shape

```typescript
interface ProtocolRequest {
  requestId: string;
  type: "shutdown" | "plan_approval";
  target?: string;
  from?: string;
  plan?: string;
  status: RequestStatus;
  timestamp: number;
}
```

```typescript
const requestId = randomUUID().substring(0, 8);
this.planRequests.set(requestId, {
  requestId,
  type: "plan_approval",
  from,
  plan,
  status: RequestStatus.PENDING,
  timestamp: Date.now() / 1000,
});
```

## What Changed From s09

| Component      | Before (s09)     | After (s10)                  |
|----------------|------------------|------------------------------|
| Tools          | spawn/send/inbox | + shutdown + plan tools      |
| Shutdown       | Natural exit     | Request-response handshake   |
| Plan gating    | None             | Submit/review with approval  |

## Try It

```sh
npm run s10
```

1. `Spawn a teammate, then request shutdown and approve`
2. `Submit a plan, reject it, then submit and approve`
3. `Monitor team status while protocols run`
