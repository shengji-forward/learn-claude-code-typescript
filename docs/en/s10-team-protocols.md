# Session 10: Team Protocols

## Overview

This session introduces structured protocols for team coordination. Learn how to implement shutdown and plan approval protocols with request ID correlation.

### What You'll Learn

- **ProtocolManager**: Track protocol requests
- **Request ID Correlation**: Match requests and responses
- **Shutdown Protocol**: Graceful team shutdown
- **Plan Approval**: Review and approve plans
- **State Management**: Track protocol states

## Running the Session

```bash
npm run s10
# or
ts-node agents/s10_team_protocols.ts
```

## Key Implementation Details

### TypeScript vs Python

**Request Tracking**:
- **Python**: Dict with threading.Lock()
- **TypeScript**: Map<string, ProtocolRequest>
- **Why**: No locks needed in single-threaded event loop

**UUID Generation**:
- **Python**: uuid.uuid4()
- **TypeScript**: crypto.randomUUID()
- **Why**: Built-in crypto API

**Type Safety**:
- **Python**: Runtime validation
- **TypeScript**: Compile-time type checking
- **Why**: Catch errors early

## Code Examples

### Protocol Interfaces and Enums

```typescript
enum RequestStatus {
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
}

interface ProtocolRequest {
    requestId: string;
    type: "shutdown" | "plan_approval";
    target?: string;
    from?: string;
    plan?: string;
    status: RequestStatus;
    timestamp: number;
}

interface ProtocolResponse {
    requestId: string;
    approved: boolean;
    reason?: string;
}
```

### ProtocolManager Class

```typescript
import { randomUUID } from "crypto";

class ProtocolManager {
    private shutdownRequests: Map<string, ProtocolRequest> = new Map();
    private planRequests: Map<string, ProtocolRequest> = new Map();

    createShutdownRequest(target: string): string {
        const requestId = randomUUID().substring(0, 8);
        this.shutdownRequests.set(requestId, {
            requestId,
            type: "shutdown",
            target,
            status: RequestStatus.PENDING,
            timestamp: Date.now() / 1000,
        });
        return requestId;
    }

    createPlanRequest(from: string, plan: string): string {
        const requestId = randomUUID().substring(0, 8);
        this.planRequests.set(requestId, {
            requestId,
            type: "plan_approval",
            from,
            plan,
            status: RequestStatus.PENDING,
            timestamp: Date.now() / 1000,
        });
        return requestId;
    }

    updateShutdownStatus(requestId: string, approved: boolean): void {
        const request = this.shutdownRequests.get(requestId);
        if (request) {
            request.status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;
        }
    }

    updatePlanStatus(requestId: string, approved: boolean): void {
        const request = this.planRequests.get(requestId);
        if (request) {
            request.status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;
        }
    }

    getShutdownRequest(requestId: string): ProtocolRequest | undefined {
        return this.shutdownRequests.get(requestId);
    }

    getPlanRequest(requestId: string): ProtocolRequest | undefined {
        return this.planRequests.get(requestId);
    }

    getPendingShutdowns(): ProtocolRequest[] {
        return Array.from(this.shutdownRequests.values()).filter(
            req => req.status === RequestStatus.PENDING
        );
    }

    getPendingPlans(): ProtocolRequest[] {
        return Array.from(this.planRequests.values()).filter(
            req => req.status === RequestStatus.PENDING
        );
    }
}
```

### Protocol Tools

```typescript
const PROTOCOLS = new ProtocolManager();

const shutdownRequestHandler: ToolHandler = async (input: unknown) => {
    const { target, reason } = input as {
        target: string;
        reason?: string;
    };

    const requestId = PROTOCOLS.createShutdownRequest(target);

    await BUS.send(target, "lead", reason || "", "shutdown_request", {
        request_id: requestId,
    });

    return `Requested shutdown from ${target} (request_id: ${requestId})`;
};

const shutdownResponseHandler: ToolHandler = async (input: unknown) => {
    const { request_id, approve, reason } = input as {
        request_id: string;
        approve: boolean;
        reason?: string;
    };

    PROTOCOLS.updateShutdownStatus(request_id, approve);

    const response: ProtocolResponse = {
        requestId: request_id,
        approved: approve,
        reason,
    };

    await BUS.send("lead", process.env.TEAMMATE_NAME || "teammate", "", "shutdown_response", response);

    return `Shutdown ${approve ? "approved" : "rejected"}`;
};

const planApprovalHandler: ToolHandler = async (input: unknown) => {
    const { plan } = input as { plan: string };

    const requestId = PROTOCOLS.createPlanRequest("teammate", plan);

    await BUS.send("lead", "teammate", plan, "plan_approval", {
        request_id: requestId,
    });

    return `Submitted plan for approval (request_id: ${requestId})`;
};
```

## Architecture

```
┌─────────────────────────────────────────┐
│          ProtocolManager                │
├─────────────────────────────────────────┤
│  + createShutdownRequest(target)       │
│  + createPlanRequest(from, plan)       │
│  + updateShutdownStatus(id, approved)  │
│  + updatePlanStatus(id, approved)      │
│  + getPendingShutdowns()               │
│  + getPendingPlans()                   │
└─────────────────────────────────────────┘
```

## Protocol Flow

**Shutdown Protocol**:
```
Lead → Teammate: shutdown_request {request_id}
Teammate → Lead: shutdown_response {request_id, approved}
```

**Plan Approval Protocol**:
```
Teammate → Lead: plan_approval {request_id, plan}
Lead → Teammate: plan_approval_response {request_id, approved}
```

## Best Practices

1. **Use unique request IDs** for correlation
2. **Track request state** throughout lifecycle
3. **Handle timeouts** for pending requests
4. **Log all protocol** messages
5. **Validate responses** before acting

## Summary

Team protocols provide structured coordination patterns. Request ID correlation ensures proper request/response matching. TypeScript enums ensure type-safe state management.

**Key Takeaways**:
- Request ID correlation
- State machine patterns
- Map-based tracking (no locks needed)
- Enum for type safety
- Message-based coordination
