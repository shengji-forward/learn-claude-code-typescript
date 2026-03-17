#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * task-worker.ts - Background Task Worker
 *
 * This worker runs shell commands in a separate thread.
 * It communicates with the main thread via postMessage.
 *
 * TypeScript Worker Threads:
 * - Uses worker_threads module (built-in Node.js)
 * - Communication via parentPort.postMessage()
 * - workerData contains initial task information
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. THREADING MODEL:
 *    - Python: threading.Thread with function target
 *    - TypeScript: Worker with separate file context
 *    - TypeScript workers run in isolated context (not shared memory)
 *
 * 2. COMMUNICATION:
 *    - Python: Shared memory with threading.Lock()
 *    - TypeScript: Message passing via postMessage/on('message')
 *    - TypeScript: No shared memory between threads
 *
 * 3. ERROR HANDLING:
 *    - Python: Exception propagates to thread, must be caught
 *    - TypeScript: Uncaught errors terminate worker, must send error message
 *
 * 4. LIFECYCLE:
 *    - Python: Daemon threads exit when main exits
 *    - TypeScript: Workers must be explicitly terminated or they keep running
 */

import { parentPort, workerData } from "worker_threads";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Worker data interface
 * TypeScript: Interface for type-safe workerData access
 * Python: Would use kwargs dict with no type checking
 */
interface WorkerTaskData {
    taskId: string;
    command: string;
    workdir: string;
    timeout?: number;
}

/**
 * Task result interface
 * TypeScript: Interface for structured result messages
 */
interface TaskResult {
    taskId: string;
    status: "completed" | "timeout" | "error";
    command: string;
    output: string;
}

/**
 * Main worker execution
 * TypeScript: Async IIFE (immediately invoked function expression)
 * Python: Would use function passed to threading.Thread target
 */
(async () => {
    const { taskId, command, workdir, timeout = 300000 } = workerData as WorkerTaskData;

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: workdir,
            timeout,
        });

        const output = (stdout + stderr).trim().substring(0, 50000);
        const result: TaskResult = {
            taskId,
            status: "completed",
            command: command.substring(0, 80),
            output: output || "(no output)",
        };

        parentPort?.postMessage(result);
    } catch (error) {
        let status: "timeout" | "error";
        let output: string;

        if ((error as any).code === "ETIMEDOUT") {
            status = "timeout";
            output = "Error: Timeout (300s)";
        } else {
            status = "error";
            output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
        }

        const result: TaskResult = {
            taskId,
            status,
            command: command.substring(0, 80),
            output,
        };

        parentPort?.postMessage(result);
    }
})();
