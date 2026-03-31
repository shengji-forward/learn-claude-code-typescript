#!/usr/bin/env ts-node
// Harness: multi-agent orchestration -- teammates with async mailboxes.
/**
 * s09_agent_teams.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate worker thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 *
 *                                         read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  # drain
 *     Worker: alice          Worker: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... runs tools   |      | ... waits ...    |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 *
 *     5 message types (all declared, not all handled here):
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. THREADING MODEL:
 *    - Python: threading.Thread with shared memory
 *    - TypeScript: Worker Threads with message passing
 *    - TypeScript: No shared memory, communicate via messages
 *
 * 2. CONFIG PERSISTENCE:
 *    - Python: Dict loaded from JSON file
 *    - TypeScript: Interface with type safety
 *    - Both: Save to config.json after changes
 *
 * 3. INBOX MANAGEMENT:
 *    - Python: Direct file I/O with Path objects
 *    - TypeScript: fs.promises with async/await
 *    - Both: JSONL format (one JSON per line)
 *
 * 4. TEAMMATE STATUS:
 *    - Python: String status in config dict
 *    - TypeScript: Enum for compile-time safety
 *    - Both: Track status (idle, working, shutdown)
 *
 * 5. WORKER LIFECYCLE:
 *    - Python: Daemon threads auto-exit
 *    - TypeScript: Workers must be explicitly terminated
 *    - TypeScript: Terminate all workers on shutdown
 *
 * 6. MESSAGE PASSING:
 *    - Python: Shared memory with threading.Lock()
 *    - TypeScript: postMessage/on('message') events
 *    - TypeScript: Structured clone for data transfer
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { existsSync, promises as fs } from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import { Worker } from "worker_threads";

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
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const execAsync = promisify(exec);

/**
 * Valid message types
 * TypeScript: Readonly array for compile-time safety
 * Python: Set of strings
 */
const VALID_MSG_TYPES = [
    "message",
    "broadcast",
    "shutdown_request",
    "shutdown_response",
    "plan_approval_response",
] as const;

type MessageType = typeof VALID_MSG_TYPES[number];

/**
 * Teammate status enum
 * TypeScript: enum for compile-time type safety
 * Python: String literals
 */
enum TeammateStatus {
    IDLE = "idle",
    WORKING = "working",
    SHUTDOWN = "shutdown",
}

/**
 * Teammate member interface
 * TypeScript: Interface with required and optional fields
 * Python: Dict with keys
 */
interface TeammateMember {
    name: string;
    role: string;
    status: TeammateStatus;
}

/**
 * Team config interface
 * TypeScript: Interface for type safety
 * Python: Dict with keys
 */
interface TeamConfig {
    team_name: string;
    members: TeammateMember[];
}

/**
 * Message interface
 * TypeScript: Interface defining message structure
 */
interface TeamMessage {
    type: MessageType;
    from: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

/**
 * MessageBus: JSONL inbox per teammate
 * TypeScript: Class with async file operations
 * Python: Class with synchronous file operations
 */
class MessageBus {
    private dir: string;

    constructor(inboxDir: string) {
        this.dir = inboxDir;
    }

    /**
     * Initialize inbox directory
     * TypeScript: Async method
     * Python: Synchronous mkdir in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
    }

    /**
     * Send message to teammate
     * TypeScript: Async method with type validation
     * Python: Synchronous method
     */
    async send(
        sender: string,
        to: string,
        content: string,
        msgType: MessageType = "message",
        extra: Record<string, any> = {}
    ): Promise<string> {
        if (!VALID_MSG_TYPES.includes(msgType)) {
            return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
        }

        const msg: TeamMessage = {
            type: msgType,
            from: sender,
            content,
            timestamp: Date.now() / 1000,
            ...extra
        };

        const inboxPath = path.join(this.dir, `${to}.jsonl`);
        const jsonLine = JSON.stringify(msg) + "\n";

        await fs.appendFile(inboxPath, jsonLine, "utf-8");
        return `Sent ${msgType} to ${to}`;
    }

    /**
     * Read and drain inbox
     * TypeScript: Async method returning Promise
     * Python: Synchronous method returning list
     */
    async readInbox(name: string): Promise<TeamMessage[]> {
        const inboxPath = path.join(this.dir, `${name}.jsonl`);

        try {
            const content = await fs.readFile(inboxPath, "utf-8");
            const lines = content.trim().split("\n");
            const messages: TeamMessage[] = [];

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
     * Broadcast message to all teammates except sender
     * TypeScript: Async method with array iteration
     * Python: Synchronous method
     */
    async broadcast(sender: string, content: string, teammates: string[]): Promise<string> {
        let count = 0;
        for (const name of teammates) {
            if (name !== sender) {
                await this.send(sender, name, content, "broadcast");
                count++;
            }
        }
        return `Broadcast to ${count} teammates`;
    }
}

// Initialize message bus
const BUS = new MessageBus(INBOX_DIR);

/**
 * TeammateManager: persistent named agents with config.json
 * TypeScript: Class with Worker management
 * Python: Class with threading.Thread management
 */
class TeammateManager {
    private dir: string;
    private configPath: string;
    private config: TeamConfig;
    private workers: Map<string, Worker> = new Map();

    constructor(teamDir: string) {
        this.dir = teamDir;
        this.configPath = path.join(teamDir, "config.json");
        this.config = { team_name: "default", members: [] };
    }

    /**
     * Initialize manager
     * TypeScript: Async initialization pattern
     * Python: Can do all initialization in __init__
     */
    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        await this.loadConfig();
        await BUS.init();
    }

    /**
     * Load config from file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async loadConfig(): Promise<void> {
        try {
            const content = await fs.readFile(this.configPath, "utf-8");
            this.config = JSON.parse(content);
        } catch (error) {
            // Use default config if file doesn't exist
            this.config = { team_name: "default", members: [] };
        }
    }

    /**
     * Save config to file
     * TypeScript: Async method
     * Python: Synchronous method
     */
    private async saveConfig(): Promise<void> {
        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.config, null, 2),
            "utf-8"
        );
    }

    /**
     * Find member by name
     * TypeScript: Method returning member or undefined
     * Python: Method returning member or None
     */
    private findMember(name: string): TeammateMember | undefined {
        return this.config.members.find(m => m.name === name);
    }

    /**
     * Spawn a new teammate
     * TypeScript: Creates Worker, returns immediately
     * Python: Creates Thread, returns immediately
     */
    async spawn(name: string, role: string, prompt: string): Promise<string> {
        const member = this.findMember(name);

        if (member) {
            if (member.status !== TeammateStatus.IDLE && member.status !== TeammateStatus.SHUTDOWN) {
                return `Error: '${name}' is currently ${member.status}`;
            }
            member.status = TeammateStatus.WORKING;
            member.role = role;
        } else {
            const newMember: TeammateMember = {
                name,
                role,
                status: TeammateStatus.WORKING
            };
            this.config.members.push(newMember);
        }

        await this.saveConfig();

        // Create worker for teammate
        const jsWorkerPath = path.join(__dirname, "teammate-worker.js");
        const tsWorkerPath = path.join(__dirname, "teammate-worker.ts");
        const workerPath = existsSync(jsWorkerPath) ? jsWorkerPath : tsWorkerPath;
        const worker = new Worker(workerPath, {
            workerData: {
                teammateName: name,
                role,
                prompt,
                workdir: WORKDIR,
                inboxDir: INBOX_DIR,
                modelId: MODEL,
                apiBase: process.env.ANTHROPIC_BASE_URL,
                sessionMode: "s09",
                protocolMode: "base",
            },
            ...(workerPath.endsWith(".ts")
                ? { execArgv: ["--loader", "ts-node/esm"] }
                : {}),
        });

        // Handle worker completion
        worker.on("message", (msg: any) => {
            if (msg.type === "teammate_complete") {
                const m = this.findMember(name);
                if (m) {
                    m.status = msg.final_status === "shutdown"
                        ? TeammateStatus.SHUTDOWN
                        : TeammateStatus.IDLE;
                    this.saveConfig();
                }
                this.workers.delete(name);
            } else if (msg.type === "tool_use") {
                console.log(`  [${msg.teammate}] ${msg.tool}: ${msg.output}`);
            }
        });

        worker.on("error", (error) => {
            console.error(`  [${name}] Worker error: ${error.message}`);
            const m = this.findMember(name);
            if (m) {
                m.status = TeammateStatus.IDLE;
                this.saveConfig();
            }
            this.workers.delete(name);
        });

        worker.on("exit", (code) => {
            if (code !== 0) {
                const m = this.findMember(name);
                if (m && m.status === TeammateStatus.WORKING) {
                    m.status = TeammateStatus.IDLE;
                    this.saveConfig();
                }
            }
            this.workers.delete(name);
        });

        this.workers.set(name, worker);

        return `Spawned '${name}' (role: ${role})`;
    }

    /**
     * List all teammates
     * TypeScript: Async method
     * Python: Synchronous method
     */
    async listAll(): Promise<string> {
        if (this.config.members.length === 0) {
            return "No teammates.";
        }

        const lines: string[] = [`Team: ${this.config.team_name}`];
        for (const m of this.config.members) {
            lines.push(`  ${m.name} (${m.role}): ${m.status}`);
        }
        return lines.join("\n");
    }

    /**
     * Get all member names
     * TypeScript: Method returning string array
     * Python: Method returning list
     */
    memberNames(): string[] {
        return this.config.members.map(m => m.name);
    }

    /**
     * Terminate all workers
     * TypeScript: Explicit cleanup required
     * Python: Daemon threads auto-clean
     */
    terminateAll(): void {
        for (const [name, worker] of Array.from(this.workers.entries())) {
            worker.terminate();
            this.workers.delete(name);
        }
    }
}

// Initialize teammate manager
const TEAMMATES = new TeammateManager(TEAM_DIR);

// -- Base tool implementations --
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

// Type for tool handler functions
type ToolHandler = (input: any) => Promise<string> | string;

/**
 * Tool handlers map
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => await runBash(input.command),
    read_file: async (input) => await runRead(input.path, input.limit),
    write_file: async (input) => await runWrite(input.path, input.content),
    edit_file: async (input) => await runEdit(input.path, input.old_text, input.new_text),
    spawn_teammate: async (input) => await TEAMMATES.spawn(input.name, input.role, input.prompt),
    list_teammates: async () => await TEAMMATES.listAll(),
    send_message: async (input) => await BUS.send(
        "lead",
        input.to,
        input.content,
        input.msg_type || "message"
    ),
    read_inbox: async () => JSON.stringify(await BUS.readInbox("lead"), null, 2),
    broadcast: async (input) => await BUS.broadcast(
        "lead",
        input.content,
        TEAMMATES.memberNames()
    ),
};

/**
 * Tool definitions for the API
 */
const TOOLS = [
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
        name: "spawn_teammate",
        description: "Spawn a new teammate agent.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: { type: "string" },
                role: { type: "string" },
                prompt: { type: "string" }
            },
            required: ["name", "role", "prompt"] as const
        }
    },
    {
        name: "list_teammates",
        description: "List all teammates and their status.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "send_message",
        description: "Send a message to a teammate.",
        input_schema: {
            type: "object" as const,
            properties: {
                to: { type: "string" },
                content: { type: "string" },
                msg_type: {
                    type: "string",
                    enum: VALID_MSG_TYPES
                }
            },
            required: ["to", "content"] as const
        }
    },
    {
        name: "read_inbox",
        description: "Read and drain the lead's inbox.",
        input_schema: {
            type: "object" as const,
            properties: {}
        }
    },
    {
        name: "broadcast",
        description: "Send a message to all teammates.",
        input_schema: {
            type: "object" as const,
            properties: {
                content: { type: "string" }
            },
            required: ["content"] as const
        }
    },
];

/**
 * Agent loop
 */
async function agentLoop(messages: any[]): Promise<void> {
    while (true) {
        const inbox = await BUS.readInbox("lead");
        if (inbox.length > 0) {
            messages.push({
                role: "user",
                content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
            });
        }

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

        const results: any[] = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const handler = TOOL_HANDLERS[block.name];
                try {
                    const output = handler
                        ? await handler(block.input)
                        : `Unknown tool: ${block.name}`;

                    console.log(`> ${block.name}:`);
                    console.log(String(output).substring(0, 200));

                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: String(output),
                    });
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : "Unknown error";
                    console.log(`> ${block.name}: Error: ${errorMsg}`);
                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: `Error: ${errorMsg}`,
                    });
                }
            }
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
    await TEAMMATES.init();

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

    console.log("\nSession 9: Agent Teams");
    console.log("Spawn persistent teammates that communicate via JSONL inboxes.\n");

    try {
        while (true) {
            const query = await question("\x1b[36ms09 >> \x1b[0m");

            if (query.trim().toLowerCase() === "q" || query.trim() === "exit" || query.trim() === "") {
                break;
            }

            history.push({
                role: "user",
                content: query,
            });

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
        TEAMMATES.terminateAll();
        rl.close();
    }
}

// Run the main function
main().catch(console.error);
