#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * teammate-worker.ts - Teammate Worker
 *
 * This worker runs a teammate agent loop in a separate thread.
 * It communicates with the main thread via postMessage.
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. AGENT LOOP:
 *    - Python: threading.Thread with target function
 *    - TypeScript: Worker with separate file context
 *    - Both: Run agent loop until task complete or max iterations
 *
 * 2. INBOX MANAGEMENT:
 *    - Python: Read JSONL inbox file directly
 *    - TypeScript: Read inbox file and report via messages
 *    - Both: Drain inbox after reading
 *
 * 3. TOOL EXECUTION:
 *    - Python: Direct function calls in _exec method
 *    - TypeScript: Send tool requests to main thread
 *    - TypeScript: Main thread executes and returns results
 *
 * 4. LIFECYCLE:
 *    - Python: Daemon threads, auto-exit with main
 *    - TypeScript: Workers must terminate explicitly
 */

import { parentPort, workerData } from "worker_threads";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Worker data interface
 */
interface TeammateData {
    teammateName: string;
    role: string;
    prompt: string;
    workdir: string;
    inboxDir: string;
    modelId: string;
    apiBase?: string;
    sessionMode: "s09" | "s10" | "s11";
    protocolMode: "base" | "protocols";
}

/**
 * Message interface
 */
interface Message {
    type: string;
    from: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

/**
 * Tool result interface
 */
interface ToolResult {
    tool_name: string;
    result: string;
}

/**
 * Initialize worker data
 */
const data = workerData as TeammateData;
const WORKDIR = data.workdir;
const INBOX_DIR = data.inboxDir;
const MODEL = data.modelId;
const ENABLE_PROTOCOL_TOOLS = data.protocolMode === "protocols";

const client = new Anthropic(
    data.apiBase ? { baseURL: data.apiBase } : undefined
);

const SYSTEM = ENABLE_PROTOCOL_TOOLS
    ? `You are '${data.teammateName}', role: ${data.role}, at ${WORKDIR}. Submit plans via plan_approval before major work. Respond to shutdown_request with shutdown_response.`
    : `You are '${data.teammateName}', role: ${data.role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;

/**
 * Safe path resolution
 */
function safePath(p: string): string {
    const resolvedPath = path.resolve(WORKDIR, p);
    if (!resolvedPath.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolvedPath;
}

/**
 * Run bash command
 */
async function runBash(command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR,
            timeout: 120000,
        });
        const output = (stdout + stderr).trim();
        return output ? output.substring(0, 50000) : "(no output)";
    } catch (error) {
        if ((error as any).code === "ETIMEDOUT") {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Read file contents
 */
async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        const lines = content.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = [
                ...lines.slice(0, limit),
                `... (${lines.length - limit} more)`
            ];
            return truncated.join("\n").substring(0, 50000);
        }

        return content.substring(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Write content to file
 */
async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const dir = path.dirname(safeFilePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(safeFilePath, content, "utf-8");
        return `Wrote ${content.length} bytes`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Edit file by replacing exact text
 */
async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");

        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        const updatedContent = content.replace(oldText, newText);
        await fs.writeFile(safeFilePath, updatedContent, "utf-8");
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Read inbox from JSONL file
 */
async function readInbox(name: string): Promise<Message[]> {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);

    try {
        const content = await fs.readFile(inboxPath, "utf-8");
        const lines = content.trim().split("\n");
        const messages: Message[] = [];

        for (const line of lines) {
            if (line) {
                messages.push(JSON.parse(line));
            }
        }

        // Clear inbox after reading
        await fs.writeFile(inboxPath, "", "utf-8");

        return messages;
    } catch (error) {
        return [];
    }
}

/**
 * Send message via JSONL inbox
 */
async function sendMessage(
    to: string,
    content: string,
    msgType: string = "message",
    extra: Record<string, any> = {}
): Promise<string> {
    const msg: Message = {
        type: msgType,
        from: data.teammateName,
        content,
        timestamp: Date.now() / 1000,
        ...extra
    };

    const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
    const jsonLine = JSON.stringify(msg) + "\n";

    await fs.appendFile(inboxPath, jsonLine, "utf-8");
    return `Sent ${msgType} to ${to}`;
}

/**
 * Execute tool and return result
 */
async function executeTool(toolName: string, args: any): Promise<string> {
    switch (toolName) {
        case "bash":
            return await runBash(args.command);
        case "read_file":
            return await runRead(args.path, args.limit);
        case "write_file":
            return await runWrite(args.path, args.content);
        case "edit_file":
            return await runEdit(args.path, args.old_text, args.new_text);
        case "send_message":
            return await sendMessage(args.to, args.content, args.msg_type || "message");
        case "read_inbox":
            const inbox = await readInbox(data.teammateName);
            return JSON.stringify(inbox, null, 2);
        case "shutdown_response":
            if (!ENABLE_PROTOCOL_TOOLS) {
                return "Error: shutdown_response is not available in this session mode.";
            }
            await sendMessage(
                "lead",
                args.reason || "",
                "shutdown_response",
                {
                    request_id: args.request_id,
                    approve: args.approve
                }
            );
            return `Shutdown ${args.approve ? "approved" : "rejected"}`;
        case "plan_approval":
            if (!ENABLE_PROTOCOL_TOOLS) {
                return "Error: plan_approval is not available in this session mode.";
            }
            const requestId = generateRequestId();
            await sendMessage(
                "lead",
                args.plan || "",
                "plan_approval_response",
                {
                    request_id: requestId,
                    plan: args.plan
                }
            );
            return `Plan submitted (request_id=${requestId}). Waiting for lead approval.`;
        default:
            return `Unknown tool: ${toolName}`;
    }
}

/**
 * Generate short request ID
 */
function generateRequestId(): string {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Main teammate agent loop
 */
async function teammateLoop(): Promise<void> {
    const messages: any[] = [
        { role: "user", content: data.prompt }
    ];

    const tools: any[] = [
        {
            name: "bash",
            description: "Run a shell command.",
            input_schema: {
                type: "object" as const,
                properties: {
                    command: { type: "string" }
                },
                required: ["command"] as const
            }
        },
        {
            name: "read_file",
            description: "Read file contents.",
            input_schema: {
                type: "object" as const,
                properties: {
                    path: { type: "string" },
                    limit: { type: "integer" }
                },
                required: ["path"] as const
            }
        },
        {
            name: "write_file",
            description: "Write content to file.",
            input_schema: {
                type: "object" as const,
                properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                },
                required: ["path", "content"] as const
            }
        },
        {
            name: "edit_file",
            description: "Replace exact text in file.",
            input_schema: {
                type: "object" as const,
                properties: {
                    path: { type: "string" },
                    old_text: { type: "string" },
                    new_text: { type: "string" }
                },
                required: ["path", "old_text", "new_text"] as const
            }
        },
        {
            name: "send_message",
            description: "Send message to a teammate.",
            input_schema: {
                type: "object" as const,
                properties: {
                    to: { type: "string" },
                    content: { type: "string" },
                    msg_type: {
                        type: "string",
                        enum: ["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"] as const
                    }
                },
                required: ["to", "content"] as const
            }
        },
        {
            name: "read_inbox",
            description: "Read and drain your inbox.",
            input_schema: {
                type: "object" as const,
                properties: {}
            }
        },
    ];

    if (ENABLE_PROTOCOL_TOOLS) {
        tools.push(
            {
                name: "shutdown_response",
                description: "Respond to a shutdown request. Approve to shut down, reject to keep working.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        request_id: { type: "string" },
                        approve: { type: "boolean" },
                        reason: { type: "string" }
                    },
                    required: ["request_id", "approve"] as const
                }
            },
            {
                name: "plan_approval",
                description: "Submit a plan for lead approval. Provide plan text.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        plan: { type: "string" }
                    },
                    required: ["plan"] as const
                }
            }
        );
    }

    let shouldExit = false;
    // Run for up to 50 iterations
    for (let i = 0; i < 50; i++) {
        // Check inbox for new messages
        const inbox = await readInbox(data.teammateName);
        for (const msg of inbox) {
            messages.push({
                role: "user",
                content: JSON.stringify(msg)
            });
        }

        try {
            const response = await client.messages.create({
                model: MODEL,
                system: SYSTEM,
                messages: messages,
                tools,
                max_tokens: 8000,
            });

            messages.push({
                role: "assistant",
                content: response.content,
            });

            if (response.stop_reason !== "tool_use") {
                break;
            }

            const results: any[] = [];
            for (const block of response.content) {
                if (block.type === "tool_use") {
                    const output = await executeTool(block.name, block.input);

                    // Notify main thread of tool usage
                    parentPort?.postMessage({
                        type: "tool_use",
                        teammate: data.teammateName,
                        tool: block.name,
                        output: String(output).substring(0, 200)
                    });

                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: String(output),
                    });

                    if (
                        ENABLE_PROTOCOL_TOOLS &&
                        block.name === "shutdown_response" &&
                        Boolean((block.input as any)?.approve)
                    ) {
                        shouldExit = true;
                    }
                }
            }

            messages.push({
                role: "user",
                content: results,
            });

            if (shouldExit) {
                break;
            }
        } catch (error) {
            break;
        }
    }

    // Notify main thread that teammate is done
    parentPort?.postMessage({
        type: "teammate_complete",
        teammate: data.teammateName,
        final_status: shouldExit ? "shutdown" : "idle"
    });
}

// Start the teammate loop
teammateLoop().catch((error) => {
    parentPort?.postMessage({
        type: "teammate_error",
        teammate: data.teammateName,
        error: error instanceof Error ? error.message : "Unknown error"
    });
});
