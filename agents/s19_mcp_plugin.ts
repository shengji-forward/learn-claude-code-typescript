#!/usr/bin/env ts-node
// @ts-nocheck
// Harness: integration -- tools aren't just in your code.
/**
 * s19_mcp_plugin.ts - MCP & Plugin System
 *
 * This teaching chapter focuses on the smallest useful idea:
 * external processes can expose tools, and your agent can treat them like
 * normal tools after a small amount of normalization.
 *
 * Minimal path:
 *   1. start an MCP server process
 *   2. ask it which tools it has
 *   3. prefix and register those tools
 *   4. route matching calls to that server
 *
 * Plugins add one more layer: discovery. A tiny manifest tells the agent which
 * external server to start.
 *
 * Key insight: "External tools should enter the same tool pipeline, not form a
 * completely separate world." In practice that means shared permission checks
 * and normalized tool_result payloads.
 *
 * Read this file in this order:
 * 1. CapabilityPermissionGate: external tools still go through the same control gate.
 * 2. MCPClient: how one server connection exposes tool specs and tool calls.
 * 3. PluginLoader: how manifests declare external servers.
 * 4. MCPToolRouter / build_tool_pool: how native and external tools merge into one pool.
 *
 * Most common confusion:
 * - a plugin manifest is not an MCP server
 * - an MCP server is not a single MCP tool
 * - external capability does not bypass the native permission path
 *
 * Teaching boundary:
 * this file teaches the smallest useful stdio MCP path.
 * Marketplace details, auth flows, reconnect logic, and non-tool capability layers
 * are intentionally left to bridge docs and later extensions.
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. MCP SERVER PROCESS:
 *    - Python: subprocess.Popen with stdin/stdout pipes
 *    - TypeScript: child_process.spawn with stdio pipes
 *    - TypeScript: Event-driven readline for stdout parsing
 *
 * 2. JSON-RPC COMMUNICATION:
 *    - Python: Direct stdin.write / stdout.readline
 *    - TypeScript: Promise-based _send/_recv with readline interface
 *    - TypeScript: Async read loop for line-delimited JSON
 *
 * 3. PERMISSION GATE:
 *    - Python: Synchronous check() with input() prompt
 *    - TypeScript: Async check() with readline question prompt
 *    - TypeScript: Same normalize/risk logic
 *
 * 4. PLUGIN LOADING:
 *    - Python: Path.exists() / Path.read_text()
 *    - TypeScript: fs.access() / fs.readFile() with async/await
 *    - TypeScript: Same manifest format and discovery logic
 *
 * 5. TOOL POOL MERGING:
 *    - Python: List concatenation with native precedence
 *    - TypeScript: Array spread with native precedence
 *    - TypeScript: Same mcp__ prefix convention
 *
 * 6. REPL:
 *    - Python: input() with colored prompt
 *    - TypeScript: readline.Interface with Promise wrapper
 *    - TypeScript: Same /tools and /mcp commands
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
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

const PERMISSION_MODES = ["default", "auto"] as const;
type PermissionMode = typeof PERMISSION_MODES[number];

/**
 * CapabilityPermissionGate
 *
 * Shared permission gate for native tools and external capabilities.
 *
 * The teaching goal is simple: MCP does not bypass the control plane.
 * Native tools and MCP tools both become normalized capability intents first,
 * then pass through the same allow / ask policy.
 *
 * TypeScript: Class with typed methods
 * Python: Class with untyped methods
 */
class CapabilityPermissionGate {
    static readonly READ_PREFIXES = ["read", "list", "get", "show", "search", "query", "inspect"];
    static readonly HIGH_RISK_PREFIXES = ["delete", "remove", "drop", "shutdown"];

    mode: PermissionMode;

    constructor(mode: PermissionMode = "default") {
        this.mode = PERMISSION_MODES.includes(mode) ? mode : "default";
    }

    /**
     * Normalize a tool call into a capability intent.
     * TypeScript: Returns typed object
     * Python: Returns dict
     */
    normalize(toolName: string, toolInput: Record<string, any>): {
        source: string;
        server: string | null;
        tool: string;
        risk: string;
    } {
        let serverName: string | null = null;
        let actualTool: string = toolName;
        let source: string = "native";

        if (toolName.startsWith("mcp__")) {
            const parts = toolName.split("__");
            if (parts.length >= 3) {
                // mcp__{server}__{tool}
                serverName = parts[1];
                actualTool = parts.slice(2).join("__");
            }
            source = "mcp";
        }

        const lowered = actualTool.toLowerCase();
        let risk: string;

        if (actualTool === "read_file" || CapabilityPermissionGate.READ_PREFIXES.some(p => lowered.startsWith(p))) {
            risk = "read";
        } else if (actualTool === "bash") {
            const command: string = toolInput.command || "";
            const dangerousTokens = ["rm -rf", "sudo", "shutdown", "reboot"];
            risk = dangerousTokens.some(token => command.includes(token)) ? "high" : "write";
        } else if (CapabilityPermissionGate.HIGH_RISK_PREFIXES.some(p => lowered.startsWith(p))) {
            risk = "high";
        } else {
            risk = "write";
        }

        return { source, server: serverName, tool: actualTool, risk };
    }

    /**
     * Check whether a tool call should be allowed or needs confirmation.
     * TypeScript: Returns typed decision object
     * Python: Returns dict
     */
    check(toolName: string, toolInput: Record<string, any>): {
        behavior: string;
        reason: string;
        intent: ReturnType<CapabilityPermissionGate["normalize"]>;
    } {
        const intent = this.normalize(toolName, toolInput);

        if (intent.risk === "read") {
            return { behavior: "allow", reason: "Read capability", intent };
        }

        if (this.mode === "auto" && intent.risk !== "high") {
            return {
                behavior: "allow",
                reason: "Auto mode for non-high-risk capability",
                intent,
            };
        }

        if (intent.risk === "high") {
            return {
                behavior: "ask",
                reason: "High-risk capability requires confirmation",
                intent,
            };
        }

        return {
            behavior: "ask",
            reason: "State-changing capability requires confirmation",
            intent,
        };
    }

    /**
     * Interactive permission prompt.
     * TypeScript: Uses readline for async input
     * Python: Uses input() for synchronous input
     */
    async askUser(intent: ReturnType<CapabilityPermissionGate["normalize"]>, toolInput: Record<string, any>): Promise<boolean> {
        const preview = JSON.stringify(toolInput).substring(0, 200);
        const source = intent.server
            ? `${intent.source}:${intent.server}/${intent.tool}`
            : `${intent.source}:${intent.tool}`;

        console.log(`\n  [Permission] ${source} risk=${intent.risk}: ${preview}`);

        const answer = await new Promise<string>((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question("  Allow? (y/n): ", (ans) => {
                rl.close();
                resolve(ans.trim().toLowerCase());
            });
        });

        return answer === "y" || answer === "yes";
    }
}

const permissionGate = new CapabilityPermissionGate();

/**
 * MCPClient
 *
 * Minimal MCP client over stdio.
 *
 * This is enough to teach the core architecture without dragging readers
 * through every transport, auth flow, or marketplace detail up front.
 *
 * TypeScript: Uses child_process.spawn with stdio pipes
 * Python: Uses subprocess.Popen with stdin/stdout pipes
 */
class MCPClient {
    serverName: string;
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
    process: ChildProcess | null = null;
    private _requestId: number = 0;
    private _tools: any[] = [];
    private _pendingResolve: ((value: any) => void) | null = null;
    private _rl: readline.Interface | null = null;

    constructor(serverName: string, command: string, args: string[] = [], env: Record<string, string> = {}) {
        this.serverName = serverName;
        this.command = command;
        this.args = args;
        this.env = { ...process.env, ...env };
    }

    /**
     * Start the MCP server process and perform handshake.
     * TypeScript: Async method using spawn
     * Python: Synchronous method using Popen
     */
    async connect(): Promise<boolean> {
        try {
            this.process = spawn(this.command, this.args, {
                stdio: ["pipe", "pipe", "pipe"],
                env: this.env as Record<string, string>,
            });

            if (!this.process.stdin || !this.process.stdout) {
                console.log(`[MCP] Failed to create pipes for ${this.serverName}`);
                return false;
            }

            // Set up readline on stdout for line-delimited JSON
            this._rl = readline.createInterface({
                input: this.process.stdout,
            });

            // Send initialize request
            await this._send({
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "teaching-agent", version: "1.0" },
                },
            });

            const response = await this._recv();
            if (response && response.result) {
                // Send initialized notification
                await this._send({ method: "notifications/initialized" });
                return true;
            }
        } catch (error: any) {
            if (error.code === "ENOENT") {
                console.log(`[MCP] Server command not found: ${this.command}`);
            } else {
                console.log(`[MCP] Connection failed: ${error.message || error}`);
            }
        }
        return false;
    }

    /**
     * Fetch available tools from the server.
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listTools(): Promise<any[]> {
        await this._send({ method: "tools/list", params: {} });
        const response = await this._recv();
        if (response && response.result) {
            this._tools = response.result.tools || [];
        }
        return this._tools;
    }

    /**
     * Execute a tool on the server.
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async callTool(toolName: string, arguments_: Record<string, any>): Promise<string> {
        await this._send({
            method: "tools/call",
            params: {
                name: toolName,
                arguments: arguments_,
            },
        });

        const response = await this._recv();
        if (response && response.result) {
            const content = response.result.content || [];
            return content.map((c: any) => c.text || String(c)).join("\n");
        }
        if (response && response.error) {
            return `MCP Error: ${response.error.message || "unknown"}`;
        }
        return "MCP Error: no response";
    }

    /**
     * Convert MCP tools to agent tool format.
     *
     * Teaching version uses the same simple prefix idea:
     * mcp__{server_name}__{tool_name}
     */
    getAgentTools(): any[] {
        const agentTools: any[] = [];
        for (const tool of this._tools) {
            const prefixedName = `mcp__${this.serverName}__${tool.name}`;
            agentTools.push({
                name: prefixedName,
                description: tool.description || "",
                input_schema: tool.inputSchema || { type: "object", properties: {} },
                _mcp_server: this.serverName,
                _mcp_tool: tool.name,
            });
        }
        return agentTools;
    }

    /**
     * Shut down the server process.
     * TypeScript: Uses process.kill() with signal fallback
     * Python: Uses process.terminate() / process.kill()
     */
    disconnect(): void {
        if (this.process) {
            try {
                this._send({ method: "shutdown" }).catch(() => {});
                this.process.kill("SIGTERM");

                // Force kill after timeout
                setTimeout(() => {
                    try {
                        this.process!.kill("SIGKILL");
                    } catch {}
                }, 5000);
            } catch {
                try {
                    this.process.kill("SIGKILL");
                } catch {}
            }
            this.process = null;
        }
        if (this._rl) {
            this._rl.close();
            this._rl = null;
        }
    }

    /**
     * Send a JSON-RPC message to the server's stdin.
     * TypeScript: Promise-based write
     * Python: Direct stdin.write
     */
    private async _send(message: Record<string, any>): Promise<void> {
        if (!this.process || this.process.exitCode !== null || !this.process.stdin) {
            return;
        }
        this._requestId++;
        const envelope: Record<string, any> = { jsonrpc: "2.0", id: this._requestId, ...message };
        const line = JSON.stringify(envelope) + "\n";
        return new Promise((resolve) => {
            this.process!.stdin!.write(line, (error) => {
                resolve();
            });
        });
    }

    /**
     * Receive a JSON-RPC response from the server's stdout.
     * TypeScript: Promise-based readline
     * Python: Direct stdout.readline
     */
    private async _recv(): Promise<any | null> {
        if (!this.process || this.process.exitCode !== null || !this._rl) {
            return null;
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(null);
            }, 30000);

            const listener = (line: string) => {
                clearTimeout(timeout);
                this._rl!.removeListener("line", listener);
                try {
                    resolve(JSON.parse(line));
                } catch {
                    resolve(null);
                }
            };

            this._rl!.once("line", listener);
        });
    }
}

/**
 * PluginLoader
 *
 * Load plugins from .claude-plugin/ directories.
 *
 * Teaching version implements the smallest useful plugin flow:
 * read a manifest, discover MCP server configs, and register them.
 *
 * TypeScript: Class with async file operations
 * Python: Class with synchronous file operations
 */
class PluginLoader {
    private searchDirs: string[];
    private plugins: Record<string, any>;

    constructor(searchDirs?: string[]) {
        this.searchDirs = searchDirs || [WORKDIR];
        this.plugins = {};
    }

    /**
     * Scan directories for .claude-plugin/plugin.json manifests.
     * TypeScript: Async method with fs operations
     * Python: Synchronous method with Path operations
     */
    async scan(): Promise<string[]> {
        const found: string[] = [];

        for (const searchDir of this.searchDirs) {
            const pluginDir = path.join(searchDir, ".claude-plugin");
            const manifestPath = path.join(pluginDir, "plugin.json");

            try {
                await fs.access(manifestPath);
                const content = await fs.readFile(manifestPath, "utf-8");
                const manifest = JSON.parse(content);
                const name = manifest.name || path.basename(path.dirname(pluginDir));
                this.plugins[name] = manifest;
                found.push(name);
            } catch (error: any) {
                // Manifest not found or invalid -- skip silently
            }
        }

        return found;
    }

    /**
     * Extract MCP server configs from loaded plugins.
     * Returns {server_name: {command, args, env}}.
     */
    getMcpServers(): Record<string, any> {
        const servers: Record<string, any> = {};
        for (const [pluginName, manifest] of Object.entries(this.plugins)) {
            const mcpServers = manifest.mcpServers || {};
            for (const [serverName, config] of Object.entries(mcpServers)) {
                servers[`${pluginName}__${serverName}`] = config;
            }
        }
        return servers;
    }
}

/**
 * MCPToolRouter
 *
 * Routes tool calls to the correct MCP server.
 *
 * MCP tools are prefixed mcp__{server}__{tool} and live alongside
 * native tools in the same tool pool. The router strips the prefix
 * and dispatches to the right MCPClient.
 */
class MCPToolRouter {
    private clients: Record<string, MCPClient> = {};

    registerClient(mcpClient: MCPClient): void {
        this.clients[mcpClient.serverName] = mcpClient;
    }

    isMcpTool(toolName: string): boolean {
        return toolName.startsWith("mcp__");
    }

    /**
     * Route an MCP tool call to the correct server.
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async call(toolName: string, arguments_: Record<string, any>): Promise<string> {
        const parts = toolName.split("__");
        if (parts.length < 3) {
            return `Error: Invalid MCP tool name: ${toolName}`;
        }
        const serverName = parts[1];
        const actualTool = parts.slice(2).join("__");
        const mcpClient = this.clients[serverName];
        if (!mcpClient) {
            return `Error: MCP server not found: ${serverName}`;
        }
        return await mcpClient.callTool(actualTool, arguments_);
    }

    /**
     * Collect tools from all connected MCP servers.
     */
    getAllTools(): any[] {
        const tools: any[] = [];
        for (const mcpClient of Object.values(this.clients)) {
            tools.push(...mcpClient.getAgentTools());
        }
        return tools;
    }
}

// -- Native tool implementations --

/**
 * Safe path resolution
 */
function safePath(filePath: string): string {
    const resolvedPath = path.resolve(WORKDIR, filePath);
    if (!resolvedPath.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return resolvedPath;
}

/**
 * Run bash command
 * TypeScript: Async function using execAsync
 * Python: Synchronous function using subprocess.run
 */
async function runBash(command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await promisify(exec)(command, {
            cwd: WORKDIR,
            timeout: 120000,
        });
        const output = (stdout + stderr).trim();
        return output ? output.substring(0, 50000) : "(no output)";
    } catch (error: any) {
        if (error.killed) {
            return "Error: Timeout (120s)";
        }
        const combined = (error.stdout || "") + (error.stderr || "");
        const msg = combined.trim();
        return msg ? msg.substring(0, 50000) : `Error: ${error.message}`;
    }
}

/**
 * Read file contents
 * TypeScript: Async function using fs.readFile
 * Python: Synchronous function using Path.read_text
 */
async function runRead(filePath: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        return content.substring(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * Write content to file
 * TypeScript: Async function using fs.writeFile
 * Python: Synchronous function using Path.write_text
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
 * TypeScript: Async function using fs.readFile/writeFile
 * Python: Synchronous function using Path.read_text/write_text
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
 * Native tool handlers
 * TypeScript: Record mapping tool names to async handler functions
 * Python: Dict mapping tool names to lambda functions
 */
const NATIVE_HANDLERS: Record<string, (input: any) => Promise<string>> = {
    bash: async (input) => await runBash(input.command),
    read_file: async (input) => await runRead(input.path),
    write_file: async (input) => await runWrite(input.path, input.content),
    edit_file: async (input) => await runEdit(input.path, input.old_text, input.new_text),
};

/**
 * Native tool definitions for the API
 * TypeScript: Array of tool definitions with typed schemas
 * Python: List of tool definition dicts
 */
const NATIVE_TOOLS = [
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

// -- MCP Tool Router (global) --
const mcpRouter = new MCPToolRouter();
const pluginLoader = new PluginLoader();

/**
 * Build the complete tool pool: native + MCP tools.
 *
 * Native tools take precedence on name conflicts so the local core remains
 * predictable even after external tools are added.
 */
function buildToolPool(): any[] {
    const allTools = [...NATIVE_TOOLS];
    const mcpTools = mcpRouter.getAllTools();

    const nativeNames = new Set(allTools.map(t => t.name));
    for (const tool of mcpTools) {
        if (!nativeNames.has(tool.name)) {
            allTools.push(tool);
        }
    }

    return allTools;
}

/**
 * Dispatch to native handler or MCP router.
 * TypeScript: Async function
 * Python: Synchronous function
 */
async function handleToolCall(toolName: string, toolInput: Record<string, any>): Promise<string> {
    if (mcpRouter.isMcpTool(toolName)) {
        return await mcpRouter.call(toolName, toolInput);
    }
    const handler = NATIVE_HANDLERS[toolName];
    if (handler) {
        return await handler(toolInput);
    }
    return `Unknown tool: ${toolName}`;
}

/**
 * Normalize tool result with source/risk/status metadata.
 * TypeScript: Function returning JSON string
 * Python: Function returning JSON string
 */
function normalizeToolResult(
    toolName: string,
    output: string,
    intent?: ReturnType<CapabilityPermissionGate["normalize"]>
): string {
    intent = intent || permissionGate.normalize(toolName, {});
    const status = output.includes("Error:") || output.includes("MCP Error:") ? "error" : "ok";
    const payload = {
        source: intent.source,
        server: intent.server,
        tool: intent.tool,
        risk: intent.risk,
        status,
        preview: output.substring(0, 500),
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * Agent loop with unified native + MCP tool pool.
 * TypeScript: Async function
 * Python: Synchronous function
 */
async function agentLoop(messages: any[]): Promise<void> {
    const tools = buildToolPool();

    while (true) {
        const system = [
            `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`,
            "You have both native tools and MCP tools available.",
            "MCP tools are prefixed with mcp__{server}__{tool}.",
            "All capabilities pass through the same permission gate before execution.",
        ].join("\n");

        const response = await client.messages.create({
            model: MODEL,
            system,
            messages,
            tools,
            max_tokens: 8000,
        });

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results: any[] = [];
        for (const block of response.content) {
            if (block.type !== "tool_use") {
                continue;
            }

            const decision = permissionGate.check(block.name, block.input || {});
            let output: string;

            try {
                if (decision.behavior === "deny") {
                    output = `Permission denied: ${decision.reason}`;
                } else if (decision.behavior === "ask" && !(await permissionGate.askUser(
                    decision.intent, block.input || {}
                ))) {
                    output = `Permission denied by user: ${decision.reason}`;
                } else {
                    output = await handleToolCall(block.name, block.input || {});
                }
            } catch (error) {
                output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
            }

            console.log(`> ${block.name}: ${String(output).substring(0, 200)}`);

            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: normalizeToolResult(
                    block.name,
                    String(output),
                    decision.intent,
                ),
            });
        }

        messages.push({ role: "user", content: results });
    }
}

/**
 * Main entry point.
 * TypeScript: Async main function with REPL
 * Python: Synchronous __main__ block
 */
async function main(): Promise<void> {
    // Scan for plugins
    const found = await pluginLoader.scan();
    if (found.length > 0) {
        console.log(`[Plugins loaded: ${found.join(", ")}]`);
        const servers = pluginLoader.getMcpServers();
        for (const [serverName, config] of Object.entries(servers)) {
            const serverConfig = config as any;
            const mcpClient = new MCPClient(
                serverName,
                serverConfig.command || "",
                serverConfig.args || [],
                serverConfig.env || {}
            );
            if (await mcpClient.connect()) {
                await mcpClient.listTools();
                mcpRouter.registerClient(mcpClient);
                console.log(`[MCP] Connected to ${serverName}`);
            }
        }
    }

    const toolCount = buildToolPool().length;
    const mcpCount = mcpRouter.getAllTools().length;
    console.log(`[Tool pool: ${toolCount} tools (${mcpCount} from MCP)]`);

    const history: any[] = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
            rl.question(prompt, resolve);
        });
    };

    try {
        while (true) {
            const query = await question("\x1b[36ms19 >> \x1b[0m");

            if (query.trim().toLowerCase() === "q" || query.trim() === "exit" || query.trim() === "") {
                break;
            }

            if (query.trim() === "/tools") {
                for (const tool of buildToolPool()) {
                    const prefix = tool.name.startsWith("mcp__") ? "[MCP] " : "       ";
                    console.log(`  ${prefix}${tool.name}: ${(tool.description || "").substring(0, 60)}`);
                }
                continue;
            }

            if (query.trim() === "/mcp") {
                const clients = (mcpRouter as any).clients as Record<string, MCPClient>;
                if (Object.keys(clients).length > 0) {
                    for (const [name, mcpClient] of Object.entries(clients)) {
                        const tools = mcpClient.getAgentTools();
                        console.log(`  ${name}: ${tools.length} tools`);
                    }
                } else {
                    console.log("  (no MCP servers connected)");
                }
                continue;
            }

            history.push({ role: "user", content: query });
            await agentLoop(history);

            const responseContent = history[history.length - 1].content;
            if (Array.isArray(responseContent)) {
                for (const block of responseContent) {
                    if (block.type === "text") {
                        console.log(block.text);
                    }
                }
            }
            console.log();
        }
    } finally {
        // Cleanup MCP connections
        const clients = (mcpRouter as any).clients as Record<string, MCPClient>;
        for (const mcpClient of Object.values(clients)) {
            mcpClient.disconnect();
        }
        rl.close();
    }
}

// Run the main function
main().catch(console.error);
