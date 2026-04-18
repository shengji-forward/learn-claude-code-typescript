#!/usr/bin/env ts-node
// Harness: safety -- the pipeline between intent and execution.
// @ts-nocheck
/**
 * s07_permission_system.ts - Permission System
 *
 * Every tool call passes through a permission pipeline before execution.
 *
 * Teaching pipeline:
 *   1. deny rules
 *   2. mode check
 *   3. allow rules
 *   4. ask user
 *
 * This version intentionally teaches three modes first:
 *   - default
 *   - plan
 *   - auto
 *
 * That is enough to build a real, understandable permission system without
 * burying readers under every advanced policy branch on day one.
 *
 * Key insight: "Safety is a pipeline, not a boolean."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. REGEX VALIDATION:
 *    - Python: re.search(pattern, command) directly
 *    - TypeScript: new RegExp(pattern).test(command)
 *    - Both return boolean match results
 *
 * 2. RULE MATCHING (fnmatch):
 *    - Python: fnmatch(path, pattern) for glob matching
 *    - TypeScript: simple globMatch() helper using * wildcards
 *    - Both support * wildcard patterns for path/content matching
 *
 * 3. INPUT/OUTPUT:
 *    - Python: input() for interactive prompts
 *    - TypeScript: readline.question() promisified
 *    - Both block for user input in the same way
 *
 * 4. PERMISSION CHECK PIPELINE:
 *    - Python: dict return {"behavior": str, "reason": str}
 *    - TypeScript: object return {behavior: string, reason: string}
 *    - Same structure, same semantics
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

// -- Permission modes --
// Teaching version starts with three clear modes first.
const MODES = ["default", "plan", "auto"] as const;
type PermissionMode = (typeof MODES)[number];

const READ_ONLY_TOOLS = new Set(["read_file", "bash_readonly"]);

// Tools that modify state
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

// -- Glob matching helper (replaces Python fnmatch) --
/**
 * Simple glob match supporting * wildcard.
 * TypeScript: Standalone function
 * Python: from fnmatch import fnmatch
 */
function globMatch(str: string, pattern: string): boolean {
    if (pattern === "*") return true;
    // Convert glob pattern to regex: * -> .*, ? -> ., escape rest
    const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${regexStr}$`).test(str);
}

// -- Bash security validation --
/**
 * Validate bash commands for obviously dangerous patterns.
 *
 * The teaching version deliberately keeps this small and easy to read.
 * First catch a few high-risk patterns, then let the permission pipeline
 * decide whether to deny or ask the user.
 *
 * TypeScript: Class with static VALIDATORS array
 * Python: class BashSecurityValidator with class-level VALIDATORS
 */
class BashSecurityValidator {
    static VALIDATORS: [string, string][] = [
        ["shell_metachar", "[;&|`$]"],       // shell metacharacters
        ["sudo", "\\bsudo\\b"],              // privilege escalation
        ["rm_rf", "\\brm\\s+(-[a-zA-Z]*)?r"], // recursive delete
        ["cmd_substitution", "\\$\\("],      // command substitution
        ["ifs_injection", "\\bIFS\\s*="],    // IFS manipulation
    ];

    /**
     * Check a bash command against all validators.
     *
     * Returns list of [validator_name, matched_pattern] tuples for failures.
     * An empty list means the command passed all validators.
     *
     * TypeScript: [string, string][] return type
     * Python: List[Tuple[str, str]] return type
     */
    validate(command: string): [string, string][] {
        const failures: [string, string][] = [];
        for (const [name, pattern] of BashSecurityValidator.VALIDATORS) {
            if (new RegExp(pattern).test(command)) {
                failures.push([name, pattern]);
            }
        }
        return failures;
    }

    /**
     * Convenience: returns true only if no validators triggered.
     */
    isSafe(command: string): boolean {
        return this.validate(command).length === 0;
    }

    /**
     * Human-readable summary of validation failures.
     */
    describeFailures(command: string): string {
        const failures = this.validate(command);
        if (!failures.length) {
            return "No issues detected";
        }
        const parts = failures.map(([name, pattern]) => `${name} (pattern: ${pattern})`);
        return "Security flags: " + parts.join(", ");
    }
}

// -- Workspace trust --
/**
 * Check if a workspace has been explicitly marked as trusted.
 *
 * The teaching version uses a simple marker file. A more complete system
 * can layer richer trust flows on top of the same idea.
 *
 * TypeScript: async function using fs.access
 * Python: synchronous Path.exists()
 */
async function isWorkspaceTrusted(workspace?: string): Promise<boolean> {
    const ws = workspace || WORKDIR;
    const trustMarker = path.join(ws, ".claude", ".claude_trusted");
    try {
        await fs.access(trustMarker);
        return true;
    } catch {
        return false;
    }
}

// Singleton validator instance used by the permission pipeline
const bashValidator = new BashSecurityValidator();

// -- Permission rules --
// Rules are checked in order: first match wins.
// Format: { tool: string, path?: string, content?: string, behavior: "allow"|"deny"|"ask" }
const DEFAULT_RULES: PermissionRule[] = [
    // Always deny dangerous patterns
    { tool: "bash", content: "rm -rf /", behavior: "deny" },
    { tool: "bash", content: "sudo *", behavior: "deny" },
    // Allow reading anything
    { tool: "read_file", path: "*", behavior: "allow" },
];

interface PermissionRule {
    tool: string;
    path?: string;
    content?: string;
    behavior: "allow" | "deny" | "ask";
}

interface PermissionDecision {
    behavior: "allow" | "deny" | "ask";
    reason: string;
}

/**
 * Manages permission decisions for tool calls.
 *
 * Pipeline: deny_rules -> mode_check -> allow_rules -> ask_user
 *
 * The teaching version keeps the decision path short on purpose so readers
 * can implement it themselves before adding more advanced policy layers.
 *
 * TypeScript: Class with typed properties
 * Python: class PermissionManager with __init__
 */
class PermissionManager {
    mode: PermissionMode;
    rules: PermissionRule[];
    consecutiveDenials: number;
    maxConsecutiveDenials: number;

    constructor(mode: PermissionMode = "default", rules?: PermissionRule[]) {
        if (!MODES.includes(mode)) {
            throw new Error(`Unknown mode: ${mode}. Choose from ${MODES.join(", ")}`);
        }
        this.mode = mode;
        this.rules = rules ?? [...DEFAULT_RULES];
        // Simple denial tracking helps surface when the agent is repeatedly
        // asking for actions the system will not allow.
        this.consecutiveDenials = 0;
        this.maxConsecutiveDenials = 3;
    }

    /**
     * Check tool call against the permission pipeline.
     *
     * Returns: { behavior: "allow"|"deny"|"ask", reason: string }
     *
     * TypeScript: Returns typed PermissionDecision
     * Python: Returns dict with same keys
     */
    check(toolName: string, toolInput: Record<string, any>): PermissionDecision {
        // Step 0: Bash security validation (before deny rules)
        // Teaching version checks early for clarity.
        if (toolName === "bash") {
            const command = (toolInput.command as string) || "";
            const failures = bashValidator.validate(command);
            if (failures.length > 0) {
                // Severe patterns (sudo, rm_rf) get immediate deny
                const severe = new Set(["sudo", "rm_rf"]);
                const severeHits = failures.filter(([name]) => severe.has(name));
                if (severeHits.length > 0) {
                    const desc = bashValidator.describeFailures(command);
                    return {
                        behavior: "deny",
                        reason: `Bash validator: ${desc}`,
                    };
                }
                // Other patterns escalate to ask (user can still approve)
                const desc = bashValidator.describeFailures(command);
                return {
                    behavior: "ask",
                    reason: `Bash validator flagged: ${desc}`,
                };
            }
        }

        // Step 1: Deny rules (bypass-immune, checked first always)
        for (const rule of this.rules) {
            if (rule.behavior !== "deny") continue;
            if (this._matches(rule, toolName, toolInput)) {
                return {
                    behavior: "deny",
                    reason: `Blocked by deny rule: ${JSON.stringify(rule)}`,
                };
            }
        }

        // Step 2: Mode-based decisions
        if (this.mode === "plan") {
            // Plan mode: deny all write operations, allow reads
            if (WRITE_TOOLS.has(toolName)) {
                return {
                    behavior: "deny",
                    reason: "Plan mode: write operations are blocked",
                };
            }
            return { behavior: "allow", reason: "Plan mode: read-only allowed" };
        }

        if (this.mode === "auto") {
            // Auto mode: auto-allow read-only tools, ask for writes
            if (READ_ONLY_TOOLS.has(toolName) || toolName === "read_file") {
                return {
                    behavior: "allow",
                    reason: "Auto mode: read-only tool auto-approved",
                };
            }
            // Teaching: fall through to allow rules, then ask
        }

        // Step 3: Allow rules
        for (const rule of this.rules) {
            if (rule.behavior !== "allow") continue;
            if (this._matches(rule, toolName, toolInput)) {
                this.consecutiveDenials = 0;
                return {
                    behavior: "allow",
                    reason: `Matched allow rule: ${JSON.stringify(rule)}`,
                };
            }
        }

        // Step 4: Ask user (default behavior for unmatched tools)
        return {
            behavior: "ask",
            reason: `No rule matched for ${toolName}, asking user`,
        };
    }

    /**
     * Interactive approval prompt. Returns true if approved.
     *
     * TypeScript: Uses passed-in readline question function
     * Python: Uses input() directly
     */
    async askUser(
        toolName: string,
        toolInput: Record<string, any>,
        askFn: (prompt: string) => Promise<string>
    ): Promise<boolean> {
        const preview = JSON.stringify(toolInput).slice(0, 200);
        console.log(`\n  [Permission] ${toolName}: ${preview}`);
        const answer = (await askFn("  Allow? (y/n/always): ")).trim().toLowerCase();

        if (answer === "always") {
            // Add permanent allow rule for this tool
            this.rules.push({ tool: toolName, path: "*", behavior: "allow" });
            this.consecutiveDenials = 0;
            return true;
        }
        if (answer === "y" || answer === "yes") {
            this.consecutiveDenials = 0;
            return true;
        }

        // Track denials for circuit breaker
        this.consecutiveDenials += 1;
        if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
            console.log(
                `  [${this.consecutiveDenials} consecutive denials -- ` +
                `consider switching to plan mode]`
            );
        }
        return false;
    }

    /**
     * Check if a rule matches the tool call.
     *
     * TypeScript: Method with typed parameters
     * Python: _matches(rule, tool_name, tool_input)
     */
    _matches(rule: PermissionRule, toolName: string, toolInput: Record<string, any>): boolean {
        // Tool name match
        if (rule.tool && rule.tool !== "*") {
            if (rule.tool !== toolName) return false;
        }
        // Path pattern match
        if ("path" in rule && rule.path && rule.path !== "*") {
            const filePath = (toolInput.path as string) || "";
            if (!globMatch(filePath, rule.path)) return false;
        }
        // Content pattern match (for bash commands)
        if ("content" in rule && rule.content) {
            const command = (toolInput.command as string) || "";
            if (!globMatch(command, rule.content)) return false;
        }
        return true;
    }
}

// -- Tool implementations --
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

async function runBash(command: string): Promise<string> {
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
        return `Wrote ${content.length} bytes to ${filePath}`;
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.`;

/**
 * The permission-aware agent loop.
 *
 * For each tool call:
 *   1. LLM requests tool use
 *   2. Permission pipeline checks: deny_rules -> mode -> allow_rules -> ask
 *   3. If allowed: execute tool, return result
 *   4. If denied: return rejection message to LLM
 *
 * TypeScript: async function with PermissionManager parameter
 * Python: def agent_loop(messages, perms)
 */
async function agentLoop(
    messages: Message[],
    perms: PermissionManager,
    askFn: (prompt: string) => Promise<string>
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

            const toolInput = (block.input as Record<string, any>) || {};

            // -- Permission check --
            const decision = perms.check(block.name, toolInput);

            let output: string;

            if (decision.behavior === "deny") {
                output = `Permission denied: ${decision.reason}`;
                console.log(`  [DENIED] ${block.name}: ${decision.reason}`);
            } else if (decision.behavior === "ask") {
                const approved = await perms.askUser(block.name, toolInput, askFn);
                if (approved) {
                    const handler = TOOL_HANDLERS[block.name];
                    try {
                        output = handler
                            ? await handler(toolInput)
                            : `Unknown: ${block.name}`;
                    } catch (error) {
                        output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
                    }
                    console.log(`> ${block.name}: ${output.slice(0, 200)}`);
                } else {
                    output = `Permission denied by user for ${block.name}`;
                    console.log(`  [USER DENIED] ${block.name}`);
                }
            } else {
                // allow
                const handler = TOOL_HANDLERS[block.name];
                try {
                    output = handler
                        ? await handler(toolInput)
                        : `Unknown: ${block.name}`;
                } catch (error) {
                    output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
                }
                console.log(`> ${block.name}: ${output.slice(0, 200)}`);
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
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    // Choose permission mode at startup
    console.log("Permission modes: default, plan, auto");
    const modeInput = (await question("Mode (default): ")).trim().toLowerCase() || "default";
    const mode = (MODES as readonly string[]).includes(modeInput)
        ? (modeInput as PermissionMode)
        : "default";

    const perms = new PermissionManager(mode);
    console.log(`[Permission mode: ${mode}]`);

    const history: Message[] = [];

    console.log("Session 7: Permission System. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms07 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                break;
            }

            // /mode command to switch modes at runtime
            if (query.startsWith("/mode")) {
                const parts = query.trim().split(/\s+/);
                if (parts.length === 2 && (MODES as readonly string[]).includes(parts[1])) {
                    perms.mode = parts[1] as PermissionMode;
                    console.log(`[Switched to ${parts[1]} mode]`);
                } else {
                    console.log(`Usage: /mode <${MODES.join("|")}>`);
                }
                continue;
            }

            // /rules command to show current rules
            if (query.trim() === "/rules") {
                perms.rules.forEach((rule, i) => {
                    console.log(`  ${i}: ${JSON.stringify(rule)}`);
                });
                continue;
            }

            history.push({
                role: "user",
                content: query,
            });

            await agentLoop(history, perms, question);

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
