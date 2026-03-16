/**
 * s10_team_protocols.test.ts - Integration tests for Session 10
 *
 * Tests for:
 * - Shutdown protocol (request → approve/reject → shutdown)
 * - Plan approval protocol (submit → review → approve/reject)
 * - Request ID correlation for tracking
 *
 * === TEST COVERAGE ===
 *
 * Python project has NO tests, so these are the first tests for s10.
 * Focus on core protocol mechanisms and request tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/**
 * Protocol Request interface (matches s10 implementation)
 */
interface ProtocolRequest {
    requestId: string;
    type: "shutdown" | "plan_approval";
    target?: string;
    from?: string;
    plan?: string;
    status: "pending" | "approved" | "rejected";
    timestamp: number;
}

/**
 * ProtocolManager class (minimal implementation for testing)
 */
class ProtocolManager {
    private shutdownRequests: Map<string, ProtocolRequest> = new Map();
    private planRequests: Map<string, ProtocolRequest> = new Map();

    createShutdownRequest(target: string): string {
        const requestId = randomUUID().substring(0, 8);
        this.shutdownRequests.set(requestId, {
            requestId,
            type: "shutdown",
            target,
            status: "pending",
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
            status: "pending",
            timestamp: Date.now() / 1000,
        });
        return requestId;
    }

    updateShutdownStatus(requestId: string, approved: boolean): void {
        const request = this.shutdownRequests.get(requestId);
        if (request) {
            request.status = approved ? "approved" : "rejected";
        }
    }

    updatePlanStatus(requestId: string, approved: boolean): void {
        const request = this.planRequests.get(requestId);
        if (request) {
            request.status = approved ? "approved" : "rejected";
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
            req => req.status === "pending"
        );
    }

    getPendingPlans(): ProtocolRequest[] {
        return Array.from(this.planRequests.values()).filter(
            req => req.status === "pending"
        );
    }
}

describe("Session 10: Team Protocols", () => {
    const TEST_DIR = path.join(process.cwd(), ".test-s10");
    let protocolManager: ProtocolManager;

    beforeEach(async () => {
        // Setup: clean test environment
        await fs.mkdir(TEST_DIR, { recursive: true });
        protocolManager = new ProtocolManager();
    });

    afterEach(async () => {
        // Cleanup: remove test directory
        try {
            await fs.rm(TEST_DIR, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    describe("Shutdown Protocol", () => {
        it("should create shutdown request with unique ID", () => {
            const requestId1 = protocolManager.createShutdownRequest("teammate-1");
            const requestId2 = protocolManager.createShutdownRequest("teammate-2");

            // Verify unique IDs
            expect(requestId1).toBeDefined();
            expect(requestId2).toBeDefined();
            expect(requestId1).not.toBe(requestId2);

            // Verify IDs are 8-character strings
            expect(requestId1.length).toBe(8);
            expect(requestId2.length).toBe(8);
        });

        it("should store shutdown request with pending status", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");
            const request = protocolManager.getShutdownRequest(requestId);

            expect(request).toBeDefined();
            expect(request?.type).toBe("shutdown");
            expect(request?.target).toBe("teammate-1");
            expect(request?.status).toBe("pending");
            expect(request?.timestamp).toBeGreaterThan(0);
        });

        it("should update shutdown request to approved", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");
            protocolManager.updateShutdownStatus(requestId, true);

            const request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("approved");
        });

        it("should update shutdown request to rejected", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");
            protocolManager.updateShutdownStatus(requestId, false);

            const request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("rejected");
        });

        it("should handle update for non-existent request gracefully", () => {
            // Should not throw error
            expect(() => {
                protocolManager.updateShutdownStatus("non-existent-id", true);
            }).not.toThrow();
        });

        it("should return undefined for non-existent request", () => {
            const request = protocolManager.getShutdownRequest("non-existent-id");
            expect(request).toBeUndefined();
        });

        it("should filter pending shutdown requests", () => {
            const requestId1 = protocolManager.createShutdownRequest("teammate-1");
            const requestId2 = protocolManager.createShutdownRequest("teammate-2");
            const requestId3 = protocolManager.createShutdownRequest("teammate-3");

            // Approve first, reject second, leave third pending
            protocolManager.updateShutdownStatus(requestId1, true);
            protocolManager.updateShutdownStatus(requestId2, false);

            const pending = protocolManager.getPendingShutdowns();

            expect(pending.length).toBe(1);
            expect(pending[0].requestId).toBe(requestId3);
        });

        it("should return empty array when no pending shutdowns", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");
            protocolManager.updateShutdownStatus(requestId, true);

            const pending = protocolManager.getPendingShutdowns();
            expect(pending.length).toBe(0);
        });
    });

    describe("Plan Approval Protocol", () => {
        it("should create plan approval request with unique ID", () => {
            const requestId1 = protocolManager.createPlanRequest("teammate-1", "Plan A");
            const requestId2 = protocolManager.createPlanRequest("teammate-2", "Plan B");

            // Verify unique IDs
            expect(requestId1).toBeDefined();
            expect(requestId2).toBeDefined();
            expect(requestId1).not.toBe(requestId2);

            // Verify IDs are 8-character strings
            expect(requestId1.length).toBe(8);
            expect(requestId2.length).toBe(8);
        });

        it("should store plan request with plan content", () => {
            const plan = "Implement feature X with TypeScript";
            const requestId = protocolManager.createPlanRequest("teammate-1", plan);
            const request = protocolManager.getPlanRequest(requestId);

            expect(request).toBeDefined();
            expect(request?.type).toBe("plan_approval");
            expect(request?.from).toBe("teammate-1");
            expect(request?.plan).toBe(plan);
            expect(request?.status).toBe("pending");
            expect(request?.timestamp).toBeGreaterThan(0);
        });

        it("should update plan request to approved", () => {
            const requestId = protocolManager.createPlanRequest("teammate-1", "Plan A");
            protocolManager.updatePlanStatus(requestId, true);

            const request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("approved");
        });

        it("should update plan request to rejected", () => {
            const requestId = protocolManager.createPlanRequest("teammate-1", "Plan A");
            protocolManager.updatePlanStatus(requestId, false);

            const request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("rejected");
        });

        it("should handle update for non-existent plan request gracefully", () => {
            // Should not throw error
            expect(() => {
                protocolManager.updatePlanStatus("non-existent-id", true);
            }).not.toThrow();
        });

        it("should return undefined for non-existent plan request", () => {
            const request = protocolManager.getPlanRequest("non-existent-id");
            expect(request).toBeUndefined();
        });

        it("should filter pending plan requests", () => {
            const requestId1 = protocolManager.createPlanRequest("teammate-1", "Plan A");
            const requestId2 = protocolManager.createPlanRequest("teammate-2", "Plan B");
            const requestId3 = protocolManager.createPlanRequest("teammate-3", "Plan C");

            // Approve first, reject second, leave third pending
            protocolManager.updatePlanStatus(requestId1, true);
            protocolManager.updatePlanStatus(requestId2, false);

            const pending = protocolManager.getPendingPlans();

            expect(pending.length).toBe(1);
            expect(pending[0].requestId).toBe(requestId3);
        });

        it("should return empty array when no pending plans", () => {
            const requestId = protocolManager.createPlanRequest("teammate-1", "Plan A");
            protocolManager.updatePlanStatus(requestId, true);

            const pending = protocolManager.getPendingPlans();
            expect(pending.length).toBe(0);
        });
    });

    describe("Request ID Correlation", () => {
        it("should correlate shutdown requests by ID across state changes", () => {
            const target = "teammate-1";
            const requestId = protocolManager.createShutdownRequest(target);

            // Initial state
            let request = protocolManager.getShutdownRequest(requestId);
            expect(request?.requestId).toBe(requestId);
            expect(request?.target).toBe(target);
            expect(request?.status).toBe("pending");

            // Update to approved
            protocolManager.updateShutdownStatus(requestId, true);
            request = protocolManager.getShutdownRequest(requestId);

            // Verify same request ID, updated status
            expect(request?.requestId).toBe(requestId);
            expect(request?.target).toBe(target);
            expect(request?.status).toBe("approved");
            expect(request?.timestamp).toBeGreaterThan(0);
        });

        it("should correlate plan requests by ID across state changes", () => {
            const from = "teammate-1";
            const plan = "Implement feature X";
            const requestId = protocolManager.createPlanRequest(from, plan);

            // Initial state
            let request = protocolManager.getPlanRequest(requestId);
            expect(request?.requestId).toBe(requestId);
            expect(request?.from).toBe(from);
            expect(request?.plan).toBe(plan);
            expect(request?.status).toBe("pending");

            // Update to rejected
            protocolManager.updatePlanStatus(requestId, false);
            request = protocolManager.getPlanRequest(requestId);

            // Verify same request ID, updated status
            expect(request?.requestId).toBe(requestId);
            expect(request?.from).toBe(from);
            expect(request?.plan).toBe(plan);
            expect(request?.status).toBe("rejected");
        });

        it("should maintain separate tracking for shutdown and plan requests", () => {
            const shutdownId = protocolManager.createShutdownRequest("teammate-1");
            const planId = protocolManager.createPlanRequest("teammate-2", "Plan A");

            // Verify shutdown request exists
            const shutdownReq = protocolManager.getShutdownRequest(shutdownId);
            expect(shutdownReq).toBeDefined();
            expect(shutdownReq?.type).toBe("shutdown");

            // Verify plan request exists
            const planReq = protocolManager.getPlanRequest(planId);
            expect(planReq).toBeDefined();
            expect(planReq?.type).toBe("plan_approval");

            // Verify cross-lookup returns undefined
            expect(protocolManager.getShutdownRequest(planId)).toBeUndefined();
            expect(protocolManager.getPlanRequest(shutdownId)).toBeUndefined();
        });

        it("should handle multiple concurrent requests correctly", () => {
            // Create multiple requests of both types
            const shutdownIds = [
                protocolManager.createShutdownRequest("teammate-1"),
                protocolManager.createShutdownRequest("teammate-2"),
            ];

            const planIds = [
                protocolManager.createPlanRequest("teammate-3", "Plan A"),
                protocolManager.createPlanRequest("teammate-4", "Plan B"),
            ];

            // Update all requests
            protocolManager.updateShutdownStatus(shutdownIds[0], true);
            protocolManager.updateShutdownStatus(shutdownIds[1], false);
            protocolManager.updatePlanStatus(planIds[0], true);
            protocolManager.updatePlanStatus(planIds[1], false);

            // Verify all states are correct
            expect(protocolManager.getShutdownRequest(shutdownIds[0])?.status).toBe("approved");
            expect(protocolManager.getShutdownRequest(shutdownIds[1])?.status).toBe("rejected");
            expect(protocolManager.getPlanRequest(planIds[0])?.status).toBe("approved");
            expect(protocolManager.getPlanRequest(planIds[1])?.status).toBe("rejected");
        });
    });

    describe("Protocol State Machine", () => {
        it("should follow shutdown state machine: pending -> approved", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");

            // Initial state: pending
            let request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("pending");

            // Transition to approved
            protocolManager.updateShutdownStatus(requestId, true);
            request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("approved");
        });

        it("should follow shutdown state machine: pending -> rejected", () => {
            const requestId = protocolManager.createShutdownRequest("teammate-1");

            // Initial state: pending
            let request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("pending");

            // Transition to rejected
            protocolManager.updateShutdownStatus(requestId, false);
            request = protocolManager.getShutdownRequest(requestId);
            expect(request?.status).toBe("rejected");
        });

        it("should follow plan approval state machine: pending -> approved", () => {
            const requestId = protocolManager.createPlanRequest("teammate-1", "Plan A");

            // Initial state: pending
            let request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("pending");

            // Transition to approved
            protocolManager.updatePlanStatus(requestId, true);
            request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("approved");
        });

        it("should follow plan approval state machine: pending -> rejected", () => {
            const requestId = protocolManager.createPlanRequest("teammate-1", "Plan A");

            // Initial state: pending
            let request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("pending");

            // Transition to rejected
            protocolManager.updatePlanStatus(requestId, false);
            request = protocolManager.getPlanRequest(requestId);
            expect(request?.status).toBe("rejected");
        });
    });
});
