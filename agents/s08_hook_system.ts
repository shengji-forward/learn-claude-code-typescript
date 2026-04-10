#!/usr/bin/env ts-node
// Harness: extensibility -- injecting behavior without touching the loop.
// @ts-nocheck
/**
 * s08_hook_system.ts - Hook System
 *
 * Hooks are extension points around the main loop.
 * They let readers add behavior without rewriting the loop itself.
 *
 * Teaching version:
 *   - SessionStart
 *   - PreToolUse
 *   - PostToolUse
 *
 * Teaching exit-code contract:
 *   - 0 -> continue
 *   - 1 -> block
 *   - 2 -> inject a message
 *
 * This is intentionally simpler than a production system. The goal here is to
 * teach the extension pattern clearly before introducing event-specific edge
 * cases.
 *
 * Key insight: "Extend the agent without touching the loop."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. SUBPROCESS EXECUTION:
 *    - Python: subprocess.run(command, shell=True, capture_output=True, ...)
 *    - TypeScript: execAsync(command, { cwd, env, timeout }) with promisified exec
 *    - Both capture stdout/stderr, both support timeouts
 *
 * 2. HOOK CONFIG LOADING:
 *    - Python: json.loads(config_path.read_text())
 *    - TypeScript: JSON.parse(await fs.readFile(configPath, "utf-8"))
 *    - TypeScript requires async for file reads
 *
 * 3. EXIT CODE HANDLING:
 *    - Python: r.returncode for subprocess exit codes
 *    - TypeScript: Check error.code field when execAsync throws
 *    - Both follow the same 0/1/2 contract
 *
 * 4. ENVIRONMENT VARIABLES:
 *    - Python: dict(os.environ) to copy env
 *    - TypeScript: { ...process.env } to spread-copy env
 *    - Both pass modified env to child process
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";

// Load environment variables
config();

if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

const execAsync = promisify(exec);

// The teaching version keeps only the three clearest events. More complete
// systems can grow the event surface later.
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
const HOOK_TIMEOUT = 30; // seconds
// Real CC timeouts:
//   TOOL_HOOK_EXECUTION_TIMEOUT_MS = 600000 (10 minutes for tool hooks)
//   SESSION_END_HOOK_TIMEOUT_MS = 1500 (1.5 seconds for SessionEnd hooks)

// Workspace trust marker. Hooks only run if this file exists (or SDK mode).
const TRUST_MARKER = path.join(WORKDIR, ".claude", ".claude_trusted");

interface HookDefinition {
    command: string;
    matcher?: string;
}

interface HookResult {
    blocked: boolean;
    messages: string[];
    block_reason?: string;
    permission_override?: string;
}

/**
 * Load and execute hooks from .hooks.json configuration.
 *
 * The hook manager does three simple jobs:
 * - load hook definitions
 * - run matching commands for an event
 * - aggregate block / message results for the caller
 *
 * TypeScript: Class with typed properties
 * Python: class HookManager
 */
class HookManager {
    hooks: Record<string, HookDefinition[]>;
    private _sdkMode: boolean;

    constructor(configPath?: string, sdkMode: boolean = false) {
        this.hooks = {
            PreToolUse: [],
            PostToolUse: [],
            SessionStart: [],
        };
        this._sdkMode = sdkMode;
        const resolvedPath = configPath || path.join(WORKDIR, ".hooks.json");

        try {
            const configText = require("fs").readFileSync(resolvedPath, "utf-8");
            const config = JSON.parse(configText);
            for (const event of HOOK_EVENTS) {
                this.hooks[event] = (config.hooks?.[event] || []);
            }
            console.log(`[Hooks loaded from ${resolvedPath}]`);
        } catch (e: any) {
            if (e.code !== "ENOENT") {
                console.log(`[Hook config error: ${e.message}]`);
            }
            // No config file is fine -- hooks are optional
        }
    }

    /**
     * Check whether the current workspace is trusted.
     *
     * The teaching version uses a simple trust marker file.
     * In SDK mode, trust is treated as implicit.
     *
     * TypeScript: Uses fs.accessSync for simplicity in constructor context
     * Python: Path.exists() check
     */
    _checkWorkspaceTrust(): boolean {
        if (this._sdkMode) return true;
        try {
            require("fs").accessSync(TRUST_MARKER);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Execute all hooks for an event.
     *
     * Returns: { blocked: boolean, messages: string[] }
     *   - blocked: true if any hook returned exit code 1
     *   - messages: stderr content from exit-code-2 hooks (to inject)
     *
     * TypeScript: async method returning typed HookResult
     * Python: def run_hooks(self, event, context) -> dict
     */
    async runHooks(event: string, context?: Record<string, any>): Promise<HookResult> {
        const result: HookResult = { blocked: false, messages: [] };

        // Trust gate: refuse to run hooks in untrusted workspaces
        if (!this._checkWorkspaceTrust()) {
            return result;
        }

        const hooks = this.hooks[event] || [];

        for (const hookDef of hooks) {
            // Check matcher (tool name filter for PreToolUse/PostToolUse)
            const matcher = hookDef.matcher;
            if (matcher && context) {
                const toolName = context.tool_name || "";
                if (matcher !== "*" && matcher !== toolName) {
                    continue;
                }
            }

            const command = hookDef.command || "";
            if (!command) continue;

            // Build environment with hook context
            // TypeScript: Spread operator for env copy
            // Python: dict(os.environ)
            const env: Record<string, string | undefined> = { ...process.env };
            if (context) {
                env.HOOK_EVENT = event;
                env.HOOK_TOOL_NAME = context.tool_name || "";
                env.HOOK_TOOL_INPUT = JSON.stringify(
                    context.tool_input || {}
                ).slice(0, 10000);
                if ("tool_output" in context) {
                    env.HOOK_TOOL_OUTPUT = String(context.tool_output).slice(0, 10000);
                }
            }

            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd: WORKDIR,
                    env: env as Record<string, string>,
                    timeout: HOOK_TIMEOUT * 1000,
                });

                // Exit code 0: continue silently
                if (stdout.trim()) {
                    console.log(`  [hook:${event}] ${stdout.trim().slice(0, 100)}`);
                }

                // Optional structured stdout: small extension point that
                // keeps the teaching contract simple.
                try {
                    const hookOutput = JSON.parse(stdout);
                    if ("updatedInput" in hookOutput && context) {
                        context.tool_input = hookOutput.updatedInput;
                    }
                    if ("additionalContext" in hookOutput) {
                        result.messages.push(hookOutput.additionalContext);
                    }
                    if ("permissionDecision" in hookOutput) {
                        result.permission_override = hookOutput.permissionDecision;
                    }
                } catch {
                    // stdout was not JSON -- normal for simple hooks
                }
            } catch (error: any) {
                // execAsync throws on non-zero exit codes
                const exitCode = error.code || 0;
                const hookStdout = error.stdout || "";
                const hookStderr = error.stderr || "";

                if (exitCode === 1) {
                    // Block execution
                    result.blocked = true;
                    const reason = hookStderr.trim() || "Blocked by hook";
                    result.block_reason = reason;
                    console.log(`  [hook:${event}] BLOCKED: ${reason.slice(0, 200)}`);
                } else if (exitCode === 2) {
                    // Inject message
                    const msg = hookStderr.trim();
                    if (msg) {
                        result.messages.push(msg);
                        console.log(`  [hook:${event}] INJECT: ${msg.slice(0, 200)}`);
                    }
                } else if (error.killed) {
                    // Timeout
                    console.log(`  [hook:${event}] Timeout (${HOOK_TIMEOUT}s)`);
                } else {
                    // Other error
                    const errStderr = hookStderr.trim();
                    if (errStderr) {
                        console.log(`  [hook:${event}] Error: ${errStderr.slice(0, 200)}`);
                    }
                }

                // Check stdout for structured output even on non-zero exit
                try {
                    const hookOutput = JSON.parse(hookStdout);
                    if ("updatedInput" in hookOutput && context) {
                        context.tool_input = hookOutput.updatedInput;
                    }
                    if ("additionalContext" in hookOutput) {
                        result.messages.push(hookOutput.additionalContext);
                    }
                    if ("permissionDecision" in hookOutput) {
                        result.permission_override = hookOutput.permissionDecision;
                    }
                } catch {
                    // Not JSON -- ignore
                }
            }
        }

        return result;
    }
}

// -- Tool implementations (same as s02) --
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

async function runBash(command: string): Promise<string> {
    const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"] as const;

    if (DANGEROUS.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR,
            timeout: 120000,
        });

        const output = (stdout + stderr).trim();
        return output ? output.slice(0, 50000) : "(no output)";
    } catch (error: any) {
        if (error && "killed" in error) {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const text = await fs.readFile(safeFilePath, "utf-8");
        const lines = text.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = lines.slice(0, limit);
            truncated.push(`... (${lines.length - limit} more lines)`);
            return truncated.join("\n");
        }

        return text.slice(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const directory = path.dirname(safeFilePath);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(safeFilePath, content, "utf-8");
        return `Wrote ${content.length} bytes`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

async function runEdit(
    filePath: string,
    oldText: string,
    newText: string
): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");

        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        const newContent = content.replace(oldText, newText);
        await fs.writeFile(safeFilePath, newContent, "utf-8");
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Tool handler type
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * THE DISPATCH MAP
 */
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
        const filePath = input.path as string;
        const content = input.content as string;
        return runWrite(filePath, content);
    },

    edit_file: async (input) => {
        const filePath = input.path as string;
        const oldText = input.old_text as string;
        const newText = input.new_text as string;
        return runEdit(filePath, oldText, newText);
    },
};

/**
 * Tool definitions
 */
const TOOLS = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object" as const,
            properties: {
                command: { type: "string" },
            },
            required: ["command"] as const,
        },
    },
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                limit: { type: "integer" },
            },
            required: ["path"] as const,
        },
    },
    {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                content: { type: "string" },
            },
            required: ["path", "content"] as const,
        },
    },
    {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
            },
            required: ["path", "old_text", "new_text"] as const,
        },
    },
];

/**
 * Message types
 */
interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

interface ContentBlock {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
    tool_use_id?: string;
    content?: string;
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

/**
 * The hook-aware agent loop.
 *
 * The teaching version keeps only the clearest integration points:
 * SessionStart, PreToolUse, execute tool, PostToolUse.
 *
 * TypeScript: async function with HookManager parameter
 * Python: def agent_loop(messages, hooks)
 */
async function agentLoop(
    messages: Message[],
    hooks: HookManager
): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens: 8000,
        });

        messages.push({
            role: "assistant",
            content: response.content,
        });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results: ToolResultBlock[] = [];

        for (const block of response.content) {
            if (block.type !== "tool_use" || !block.id || !block.name) continue;

            const toolInput = { ...(block.input as Record<string, any> || {}) };
            const ctx: Record<string, any> = {
                tool_name: block.name,
                tool_input: toolInput,
            };

            // -- PreToolUse hooks --
            const preResult = await hooks.runHooks("PreToolUse", ctx);

            // Inject hook messages into results
            for (const msg of preResult.messages) {
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: `[Hook message]: ${msg}`,
                });
            }

            if (preResult.blocked) {
                const reason = preResult.block_reason || "Blocked by hook";
                const output = `Tool blocked by PreToolUse hook: ${reason}`;
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
                continue;
            }

            // -- Execute tool --
            const handler = TOOL_HANDLERS[block.name];
            let output: string;
            try {
                output = handler
                    ? await handler(toolInput)
                    : `Unknown: ${block.name}`;
            } catch (error) {
                output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
            }
            console.log(`> ${block.name}: ${output.slice(0, 200)}`);

            // -- PostToolUse hooks --
            ctx.tool_output = output;
            const postResult = await hooks.runHooks("PostToolUse", ctx);

            // Inject post-hook messages
            for (const msg of postResult.messages) {
                output += `\n[Hook note]: ${msg}`;
            }

            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: output,
            });
        }

        messages.push({
            role: "user",
            content: results,
        });
    }
}

/**
 * Main REPL loop
 */
async function main(): Promise<void> {
    const hooks = new HookManager();

    // Fire SessionStart hooks
    await hooks.runHooks("SessionStart", { tool_name: "", tool_input: {} });

    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 8: Hook System. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms08 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                break;
            }

            history.push({
                role: "user",
                content: query,
            });

            await agentLoop(history, hooks);

            const responseContent = history[history.length - 1].content;
            if (Array.isArray(responseContent)) {
                for (const block of responseContent) {
                    if ("text" in block && typeof block.text === "string") {
                        console.log(block.text);
                    }
                }
            }
            console.log();
        } catch (error) {
            if (
                error instanceof Error &&
                (error.message.includes("EOF") || error.message.includes("SIGINT"))
            ) {
                break;
            }
            console.error("Error:", error);
        }
    }

    rl.close();
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
