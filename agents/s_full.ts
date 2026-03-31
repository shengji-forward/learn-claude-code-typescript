#!/usr/bin/env ts-node
// Harness: complete integration -- all mechanisms, one unified system.
// @ts-nocheck
/**
 * s_full.ts - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * This TypeScript version mirrors the Python s_full.py structure with these key differences:
 * - All file operations use fs/promises (async) instead of pathlib (sync)
 * - Type annotations and interfaces for compile-time safety
 * - Deep cloning uses JSON.parse(JSON.stringify()) instead of copy.deepcopy
 * - Threading replaced with worker_threads module for background tasks
 * - Error handling uses try/catch with instanceof checks
 * - Module system uses ES imports instead of Python imports
 *
 * === INTEGRATED SESSIONS ===
 *
 * - s01: Agent loop with async/await
 * - s02: Type-safe tool dispatch
 * - s03: Todo write for progress tracking
 * - s04: Subagent with context isolation
 * - s05: Skill loading with YAML frontmatter
 * - s06: Context compression pipeline
 * - s07: Task system with JSON persistence
 * - s08: Background tasks with Worker Threads
 * - s09: Agent teams with JSONL messaging
 * - s10: Team protocols (request-response)
 * - s11: Autonomous agents (idle cycle)
 *
 * === ARCHITECTURE ===
 *
 * +------------------------------------------------------------------+
 * |                        FULL AGENT                                 |
 * |                                                                   |
 * |  System prompt (s05 skills, task-first + optional todo nag)      |
 * |                                                                   |
 * |  Before each LLM call:                                            |
 * |  +--------------------+  +------------------+  +--------------+  |
 * |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 * |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 * |  +--------------------+  +------------------+  +--------------+  |
 * |                                                                   |
 * |  Tool dispatch (s02 pattern):                                     |
 * |  +--------+----------+----------+---------+-----------+          |
 * |  | bash   | read     | write    | edit    | TodoWrite |          |
 * |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 * |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 * |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 * |  | plan   | idle     | claim    |         |           |          |
 * |  +--------+----------+----------+---------+-----------+          |
 * |                                                                   |
 * |  Subagent (s04):  spawn -> work -> return summary                 |
 * |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 * |  Shutdown (s10):  request_id handshake                            |
 * |  Plan gate (s10): submit -> approve/reject                        |
 * +------------------------------------------------------------------+
 *
 * REPL commands: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";

// Import types from SDK
type ContentBlock = Anthropic.ContentBlock;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type MessageParam = Anthropic.MessageParam;

// Load environment variables
config();
if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// Constants
const WORKDIR = process.cwd();
const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = new Set([
    "message",
    "broadcast",
    "shutdown_request",
    "shutdown_response",
    "plan_approval_response",
]);

// === TYPESCRIPT VS PYTHON: Type Definitions ===
// Python uses duck typing and type hints. TypeScript uses interfaces for compile-time checking.
// For the capstone, we use Anthropic SDK types directly

type Message = MessageParam;

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
}

interface Task {
    id: number;
    subject: string;
    description: string;
    status: "pending" | "in_progress" | "completed" | "deleted";
    owner: string | null;
    blockedBy: number[];
}

interface BackgroundTask {
    status: "running" | "completed" | "error";
    command: string;
    result: string | null;
}

interface TeamMessage {
    type: string;
    from: string;
    content: string;
    timestamp: number;
    request_id?: string;
    approve?: boolean;
    feedback?: string;
}

interface TeamMember {
    name: string;
    role: string;
    status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
    team_name: string;
    members: TeamMember[];
}

interface ProtocolRequest {
    target: string;
    status: "pending" | "approved" | "rejected";
    from: string;
}

// === SECTION: base_tools ===

/**
 * TYPESCRIPT VS PYTHON: Path safety
 * Python: uses pathlib.Path for path manipulation
 * TypeScript: uses path module and string manipulation
 */
function safePath(p: string): string {
    const resolved = path.resolve(WORKDIR, p);
    if (!resolved.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolved;
}

/**
 * TYPESCRIPT VS PYTHON: Subprocess execution
 * Python: subprocess.run() returns synchronously
 * TypeScript: Use promisified exec for async execution
 */
async function runBash(command: string): Promise<string> {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR,
            timeout: 120000,
            maxBuffer: 50000 * 1024,
        });
        const out = (stdout + stderr).trim();
        return out || "(no output)";
    } catch (error: unknown) {
        if (error instanceof Error) {
            if ("killed" in error && (error as any).killed) {
                return "Error: Timeout (120s)";
            }
            return `Error: ${error.message}`;
        }
        return "Error: Unknown error";
    }
}

async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safe = safePath(filePath);
        const content = await fs.readFile(safe, "utf-8");
        const lines = content.split("\n");
        if (limit && limit < lines.length) {
            const truncated = [
                ...lines.slice(0, limit),
                `... (${lines.length - limit} more)`,
            ];
            return truncated.join("\n").slice(0, 50000);
        }
        return content.slice(0, 50000);
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : "Unknown"}`;
    }
}

async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safe = safePath(filePath);
        const dir = path.dirname(safe);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(safe, content);
        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : "Unknown"}`;
    }
}

async function runEdit(
    filePath: string,
    oldText: string,
    newText: string
): Promise<string> {
    try {
        const safe = safePath(filePath);
        const content = await fs.readFile(safe, "utf-8");
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }
        const updated = content.replace(oldText, newText);
        await fs.writeFile(safe, updated);
        return `Edited ${filePath}`;
    } catch (error: unknown) {
        return `Error: ${error instanceof Error ? error.message : "Unknown"}`;
    }
}

// Helper to convert SDK ContentBlock[] to our Message format
function sdkContentToMessage(content: ContentBlock[]): Message {
    return {
        role: "assistant",
        content: content.map(block => {
            if (block.type === "text") {
                return { type: "text" as const, text: (block as { text: string }).text };
            } else if (block.type === "tool_use") {
                return block as ToolUseBlock;
            } else {
                return block;
            }
        })
    };
}

// === SECTION: todos (s03) ===

/**
 * TYPESCRIPT VS PYTHON: Class with type annotations
 * Python: Uses type hints and validation with raise ValueError
 * TypeScript: Uses interfaces and throws Error with type checking
 */
class TodoManager {
    private items: TodoItem[] = [];

    update(newItems: TodoItem[]): string {
        const validated: TodoItem[] = [];
        let inProgress = 0;

        for (let i = 0; i < newItems.length; i++) {
            const item = newItems[i];
            const content = String(item.content || "").trim();
            const status = item.status || "pending";
            const activeForm = String(item.activeForm || "").trim();

            if (!content) {
                throw new Error(`Item ${i}: content required`);
            }
            if (!["pending", "in_progress", "completed"].includes(status)) {
                throw new Error(`Item ${i}: invalid status '${status}'`);
            }
            if (!activeForm) {
                throw new Error(`Item ${i}: activeForm required`);
            }
            if (status === "in_progress") {
                inProgress++;
            }

            validated.push({ content, status, activeForm });
        }

        if (validated.length > 20) {
            throw new Error("Max 20 todos");
        }
        if (inProgress > 1) {
            throw new Error("Only one in_progress allowed");
        }

        this.items = validated;
        return this.render();
    }

    render(): string {
        if (this.items.length === 0) {
            return "No todos.";
        }

        const lines: string[] = [];
        for (const item of this.items) {
            const marker =
                {
                    completed: "[x]",
                    in_progress: "[>]",
                    pending: "[ ]",
                }[item.status] || "[?]";
            const suffix =
                item.status === "in_progress"
                    ? ` <- ${item.activeForm}`
                    : "";
            lines.push(`${marker} ${item.content}${suffix}`);
        }

        const completed = this.items.filter(
            (t) => t.status === "completed"
        ).length;
        lines.push(`\n(${completed}/${this.items.length} completed)`);

        return lines.join("\n");
    }

    hasOpenItems(): boolean {
        return this.items.some((item) => item.status !== "completed");
    }
}

// === SECTION: subagent (s04) ===

/**
 * TYPESCRIPT VS PYTHON: Deep cloning
 * Python: copy.deepcopy(messages) for recursive copy
 * TypeScript: JSON.parse(JSON.stringify(messages)) for deep clone
 */
function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

/**
 * TYPESCRIPT VS PYTHON: Async subagent loop
 * Python: Synchronous for loop with client.messages.create()
 * TypeScript: Async/await with recursive loop
 */
async function runSubagent(
    prompt: string,
    agentType: string = "Explore"
): Promise<string> {
    const subTools = [
        {
            name: "bash",
            description: "Run command.",
            input_schema: {
                type: "object" as const,
                properties: {
                    command: { type: "string" as const },
                },
                required: ["command"],
            },
        },
        {
            name: "read_file",
            description: "Read file.",
            input_schema: {
                type: "object" as const,
                properties: {
                    path: { type: "string" as const },
                },
                required: ["path"],
            },
        },
    ];

    if (agentType !== "Explore") {
        subTools.push(
            {
                name: "write_file",
                description: "Write file.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string" as const },
                        content: { type: "string" as const } as any,
                    } as any,
                    required: ["path", "content"],
                },
            },
            {
                name: "edit_file",
                description: "Edit file.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string" as const },
                        old_text: { type: "string" as const },
                        new_text: { type: "string" as const },
                    } as any,
                    required: ["path", "old_text", "new_text"],
                },
            }
        );
    }

    const subHandlers: Record<
        string,
        (input: Record<string, unknown>) => Promise<string>
    > = {
        bash: async (input) => await runBash(input.command as string),
        read_file: async (input) =>
            await runRead(input.path as string),
        write_file: async (input) =>
            await runWrite(
                input.path as string,
                input.content as string
            ),
        edit_file: async (input) =>
            await runEdit(
                input.path as string,
                input.old_text as string,
                input.new_text as string
            ),
    };

    let subMessages: Message[] = [
        { role: "user", content: prompt },
    ];

    let response: Anthropic.Message | null = null;

    for (let i = 0; i < 30; i++) {
        response = await client.messages.create({
            model: MODEL,
            messages: subMessages,
            tools: subTools as any,
            max_tokens: 8000,
        });

        subMessages.push({
            role: "assistant",
            content: response.content as any,
        });

        if (response.stop_reason !== "tool_use") {
            break;
        }

        const results: ToolResultBlockParam[] = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const handler = subHandlers[block.name];
                const output = handler
                    ? await handler((block as any).input)
                    : "Unknown tool";
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output.slice(0, 50000) || "",
                });
            }
        }

        subMessages.push({ role: "user", content: results as any });
    }

    if (response) {
        return (
            response.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("") || "(no summary)"
        );
    }

    return "(subagent failed)";
}

// === SECTION: skills (s05) ===

interface Skill {
    meta: Record<string, string>;
    body: string;
}

/**
 * TYPESCRIPT VS PYTHON: YAML parsing
 * Python: Uses re.match() for YAML frontmatter
 * TypeScript: Uses js-yaml library for type-safe parsing
 */
class SkillLoader {
    private skills: Map<string, Skill> = new Map();

    constructor(skillsDir: string) {
        this.loadSkills(skillsDir);
    }

    private async loadSkills(skillsDir: string): Promise<void> {
        try {
            const exists = await fs
                .access(skillsDir)
                .then(() => true)
                .catch(() => false);
            if (!exists) return;

            const walkDir = async (dir: string): Promise<string[]> => {
                const files: string[] = [];
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        files.push(...(await walkDir(fullPath)));
                    } else if (entry.name === "SKILL.md") {
                        files.push(fullPath);
                    }
                }
                return files;
            };

            const skillFiles = await walkDir(skillsDir);
            skillFiles.sort();

            for (const filePath of skillFiles) {
                const text = await fs.readFile(filePath, "utf-8");
                // Use [\s\S] instead of /s flag for ES2022 compatibility
                const frontmatterMatch = text.match(
                    /^---\n([\s\S]*?)\n---\n([\s\S]*)/
                );

                let meta: Record<string, string> = {};
                let body = text;

                if (frontmatterMatch) {
                    try {
                        meta = (yaml.load(
                            frontmatterMatch[1]
                        ) as Record<string, string>) || {};
                        body = frontmatterMatch[2].trim();
                    } catch (error) {
                        // Invalid YAML, treat entire file as body
                    }
                }

                const name = meta.name || path.basename(path.dirname(filePath));
                this.skills.set(name, { meta, body });
            }
        } catch (error) {
            // Skills directory doesn't exist or is empty
        }
    }

    descriptions(): string {
        if (this.skills.size === 0) {
            return "(no skills)";
        }

        const lines: string[] = [];
        for (const [name, skill] of Array.from(this.skills.entries())) {
            const desc = skill.meta.description || "-";
            lines.push(`  - ${name}: ${desc}`);
        }
        return lines.join("\n");
    }

    load(name: string): string {
        const skill = this.skills.get(name);
        if (!skill) {
            const available = Array.from(this.skills.keys()).join(", ");
            return `Error: Unknown skill '${name}'. Available: ${available}`;
        }
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}

// === SECTION: compression (s06) ===

/**
 * TYPESCRIPT VS PYTHON: Token estimation
 * Python: len(json.dumps(messages, default=str)) // 4
 * TypeScript: Similar logic with proper typing
 */
function estimateTokens(messages: Message[]): number {
    return JSON.stringify(messages, (_, v) => v?.toString?.() ?? v).length / 4;
}

/**
 * TYPESCRIPT VS PYTHON: Message manipulation
 * Python: Direct mutation with for loops and isinstance checks
 * TypeScript: Type-safe mutation with type guards
 */
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

function microcompact(messages: Message[]): void {
    const toClear: { content: string; tool_use_id?: string }[] = [];

    for (const msg of messages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (
                    "type" in part &&
                    part.type === "tool_result" &&
                    typeof (part as any).content === "string"
                ) {
                    toClear.push(part as any);
                }
            }
        }
    }

    if (toClear.length <= 3) {
        return;
    }

    // Build tool_name map by matching tool_use_id in prior assistant messages
    const toolNameMap = new Map<string, string>();
    for (const msg of messages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content as any[]) {
                if (block.type === "tool_use" && block.id && block.name) {
                    toolNameMap.set(block.id, block.name);
                }
            }
        }
    }

    for (const part of toClear.slice(0, -3)) {
        if (typeof part.content === "string" && part.content.length > 100) {
            const toolId = part.tool_use_id || "";
            const toolName = toolNameMap.get(toolId) || "unknown";
            // Preserve read_file outputs — they are reference material
            if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
            part.content = `[Previous: used ${toolName}]`;
        }
    }
}

/**
 * TYPESCRIPT VS PYTHON: Async file operations
 * Python: Synchronous file operations with open()
 * TypeScript: Async operations with fs/promises
 */
async function autoCompact(messages: Message[]): Promise<Message[]> {
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });

    const timestamp = Date.now();
    const transcriptPath = path.join(
        TRANSCRIPT_DIR,
        `transcript_${timestamp}.jsonl`
    );

    const transcriptData = messages
        .map((msg) =>
            JSON.stringify(msg, (_, v) => v?.toString?.() ?? v)
        )
        .join("\n");
    await fs.writeFile(transcriptPath, transcriptData);

    const convText = JSON.stringify(messages, (_, v) =>
        v?.toString?.() ?? v
    ).slice(-80000);

    const summaryResponse = await client.messages.create({
        model: MODEL,
        messages: [
            {
                role: "user",
                content: `Summarize for continuity:\n${convText}`,
            },
        ],
        max_tokens: 2000,
    });

    const summary =
        (summaryResponse.content[0] as { text: string }).text || "";

    return [
        {
            role: "user",
            content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}`,
        },
    ];
}

// === SECTION: file_tasks (s07) ===

/**
 * TYPESCRIPT VS PYTHON: Async file I/O
 * Python: Path.read_text() and path.write_text() are synchronous
 * TypeScript: fs.readFile() and fs.writeFile() are async
 */
class TaskManager {
    private tasksPath: string;

    constructor() {
        this.tasksPath = TASKS_DIR;
        this.init();
    }

    private async init(): Promise<void> {
        await fs.mkdir(this.tasksPath, { recursive: true });
    }

    private async nextId(): Promise<number> {
        try {
            const files = await fs.readdir(this.tasksPath);
            const ids = files
                .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
                .map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
            return ids.length > 0 ? Math.max(...ids) + 1 : 1;
        } catch {
            return 1;
        }
    }

    private async load(taskId: number): Promise<Task> {
        const filePath = path.join(this.tasksPath, `task_${taskId}.json`);
        try {
            const content = await fs.readFile(filePath, "utf-8");
            return JSON.parse(content) as Task;
        } catch {
            throw new Error(`Task ${taskId} not found`);
        }
    }

    private async save(task: Task): Promise<void> {
        const filePath = path.join(this.tasksPath, `task_${task.id}.json`);
        await fs.writeFile(filePath, JSON.stringify(task, null, 2));
    }

    async create(subject: string, description = ""): Promise<string> {
        await this.init();
        const id = await this.nextId();
        const task: Task = {
            id,
            subject,
            description,
            status: "pending",
            owner: null,
            blockedBy: [],
        };
        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    async get(taskId: number): Promise<string> {
        const task = await this.load(taskId);
        return JSON.stringify(task, null, 2);
    }

    async update(
        taskId: number,
        status?: Task["status"],
        addBlockedBy?: number[],
        removeBlockedBy?: number[]
    ): Promise<string> {
        const task = await this.load(taskId);

        if (status) {
            task.status = status;
            if (status === "completed") {
                // Remove this task from blockedBy lists of other tasks
                const files = await fs.readdir(this.tasksPath);
                for (const file of files) {
                    if (file.startsWith("task_") && file.endsWith(".json")) {
                        const otherTask = JSON.parse(
                            await fs.readFile(
                                path.join(this.tasksPath, file),
                                "utf-8"
                            )
                        ) as Task;
                        if (otherTask.blockedBy.includes(taskId)) {
                            otherTask.blockedBy = otherTask.blockedBy.filter(
                                (id) => id !== taskId
                            );
                            await this.save(otherTask);
                        }
                    }
                }
            }
            if (status === "deleted") {
                const filePath = path.join(
                    this.tasksPath,
                    `task_${taskId}.json`
                );
                await fs.unlink(filePath).catch(() => {});
                return `Task ${taskId} deleted`;
            }
        }

        if (addBlockedBy) {
            task.blockedBy = Array.from(new Set([...task.blockedBy, ...addBlockedBy]));
        }
        if (removeBlockedBy) {
            task.blockedBy = task.blockedBy.filter(
                (id) => !removeBlockedBy.includes(id)
            );
        }

        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    async listAll(): Promise<string> {
        await this.init();
        try {
            const files = await fs.readdir(this.tasksPath);
            const taskFiles = files
                .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
                .sort();

            if (taskFiles.length === 0) {
                return "No tasks.";
            }

            const tasks: Task[] = [];
            for (const file of taskFiles) {
                const content = await fs.readFile(
                    path.join(this.tasksPath, file),
                    "utf-8"
                );
                tasks.push(JSON.parse(content));
            }

            const lines: string[] = [];
            for (const t of tasks) {
                const marker =
                    {
                        pending: "[ ]",
                        in_progress: "[>]",
                        completed: "[x]",
                    }[t.status] || "[?]";
                const owner = t.owner ? ` @${t.owner}` : "";
                const blocked =
                    t.blockedBy.length > 0
                        ? ` (blocked by: ${t.blockedBy.join(", ")})`
                        : "";
                lines.push(`${marker} #${t.id}: ${t.subject}${owner}${blocked}`);
            }

            return lines.join("\n");
        } catch {
            return "No tasks.";
        }
    }

    async claim(taskId: number, owner: string): Promise<string> {
        const task = await this.load(taskId);
        if (task.owner) {
            return `Error: Task ${taskId} has already been claimed by ${task.owner}`;
        }
        if (task.status !== "pending") {
            return `Error: Task ${taskId} cannot be claimed because its status is '${task.status}'`;
        }
        if (task.blockedBy.length > 0) {
            return `Error: Task ${taskId} is blocked by other task(s) and cannot be claimed yet`;
        }
        task.owner = owner;
        task.status = "in_progress";
        await this.save(task);
        return `Claimed task #${taskId} for ${owner}`;
    }
}

// === SECTION: background (s08) ===

/**
 * TYPESCRIPT VS PYTHON: Worker Threads
 * Python: threading.Thread with daemon threads
 * TypeScript: worker.Worker with proper message passing
 */
class BackgroundManager {
    private tasks: Map<string, BackgroundTask> = new Map();
    private notifications: Array<{
        task_id: string;
        status: string;
        result: string;
    }> = [];

    /**
     * TYPESCRIPT VS PYTHON: Worker message passing
     * Python: Queue.put() and Queue.get() for thread-safe communication
     * TypeScript: worker.postMessage() and worker.on() for communication
     */
    async run(command: string, timeout = 120): Promise<string> {
        const taskId = Math.random().toString(36).substring(2, 10);
        this.tasks.set(taskId, {
            status: "running",
            command,
            result: null,
        });

        // Create worker inline for this self-contained implementation
        const workerCode = `
            const { parentPort } = require('worker_threads');
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            (async () => {
                const { command, timeout, workdir } = require('worker_threads').workerData;
                try {
                    const { stdout, stderr } = await execAsync(command, {
                        cwd: workdir,
                        timeout: timeout * 1000,
                        maxBuffer: 50000 * 1024,
                    });
                    const output = (stdout + stderr).trim().slice(0, 50000);
                    parentPort.postMessage({ taskId, status: 'completed', result: output || '(no output)' });
                } catch (error) {
                    const result = error.killed ? 'Error: Timeout' : error.message;
                    parentPort.postMessage({ taskId, status: 'error', result });
                }
            })();
        `;

        const worker = new Worker(workerCode, {
            eval: true,
            workerData: { command, timeout, workdir: WORKDIR },
        });

        worker.on("message", (data: { taskId: string; status: string; result: string }) => {
            const task = this.tasks.get(data.taskId);
            if (task) {
                task.status = data.status as BackgroundTask["status"];
                task.result = data.result;
                this.notifications.push({
                    task_id: data.taskId,
                    status: data.status,
                    result: data.result.slice(0, 500),
                });
            }
        });

        return `Background task ${taskId} started: ${command.slice(0, 80)}`;
    }

    check(taskId?: string): string {
        if (taskId) {
            const task = this.tasks.get(taskId);
            if (!task) {
                return `Unknown: ${taskId}`;
            }
            return `[${task.status}] ${task.result || "(running)"}`;
        }

        const lines: string[] = [];
        for (const [id, task] of Array.from(this.tasks.entries())) {
            lines.push(`${id}: [${task.status}] ${task.command.slice(0, 60)}`);
        }
        return lines.join("\n") || "No bg tasks.";
    }

    drain(): Array<{ task_id: string; status: string; result: string }> {
        const notifs = [...this.notifications];
        this.notifications = [];
        return notifs;
    }
}

// === SECTION: messaging (s09) ===

/**
 * TYPESCRIPT VS PYTHON: Async JSONL operations
 * Python: Synchronous file operations with open()
 * TypeScript: Async operations with fs/promises
 */
class MessageBus {
    private inboxDir: string;

    constructor() {
        this.inboxDir = INBOX_DIR;
        this.init();
    }

    private async init(): Promise<void> {
        await fs.mkdir(this.inboxDir, { recursive: true });
    }

    async send(
        sender: string,
        to: string,
        content: string,
        msgType = "message",
        extra?: Record<string, unknown>
    ): Promise<string> {
        await this.init();

        const msg: TeamMessage = {
            type: msgType,
            from: sender,
            content,
            timestamp: Date.now(),
            ...extra,
        };

        const inboxPath = path.join(this.inboxDir, `${to}.jsonl`);
        const line = JSON.stringify(msg) + "\n";
        await fs.appendFile(inboxPath, line);

        return `Sent ${msgType} to ${to}`;
    }

    async readInbox(name: string): Promise<TeamMessage[]> {
        await this.init();

        const inboxPath = path.join(this.inboxDir, `${name}.jsonl`);
        try {
            const content = await fs.readFile(inboxPath, "utf-8");
            const lines = content.trim().split("\n").filter(Boolean);
            const messages = lines.map((line) => JSON.parse(line) as TeamMessage);

            // Clear the inbox after reading
            await fs.writeFile(inboxPath, "");

            return messages;
        } catch {
            return [];
        }
    }

    async broadcast(sender: string, content: string, names: string[]): Promise<string> {
        let count = 0;
        for (const name of names) {
            if (name !== sender) {
                await this.send(sender, name, content, "broadcast");
                count++;
            }
        }
        return `Broadcast to ${count} teammates`;
    }
}

// === SECTION: shutdown + plan tracking (s10) ===

/**
 * TYPESCRIPT VS PYTHON: Map instead of dict
 * Python: Uses plain dict for request tracking
 * TypeScript: Uses Map<string, ProtocolRequest> for type safety
 */
const shutdownRequests = new Map<string, ProtocolRequest>();
const planRequests = new Map<string, ProtocolRequest>();

// === SECTION: team (s09/s11) ===

/**
 * TYPESCRIPT VS PYTHON: Async teammate loop with workers
 * Python: threading.Thread for concurrent teammate execution
 * TypeScript: Can use worker.Worker for actual isolation, but for simplicity
 *             we'll use async functions in this self-contained example
 */
class TeammateManager {
    private bus: MessageBus;
    private taskMgr: TaskManager;
    private configPath: string;
    private config: TeamConfig;

    constructor(bus: MessageBus, taskMgr: TaskManager) {
        this.bus = bus;
        this.taskMgr = taskMgr;
        this.configPath = path.join(TEAM_DIR, "config.json");
        this.config = { team_name: "default", members: [] };
        this.init();
    }

    private async init(): Promise<void> {
        await fs.mkdir(TEAM_DIR, { recursive: true });
        await this.loadConfig();
    }

    private async loadConfig(): Promise<void> {
        try {
            const content = await fs.readFile(this.configPath, "utf-8");
            this.config = JSON.parse(content) as TeamConfig;
        } catch {
            this.config = { team_name: "default", members: [] };
        }
    }

    private async saveConfig(): Promise<void> {
        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.config, null, 2)
        );
    }

    private findMember(name: string): TeamMember | undefined {
        return this.config.members.find((m) => m.name === name);
    }

    /**
     * TYPESCRIPT VS PYTHON: Async teammate spawning
     * Python: threading.Thread(target=self._loop, args=(...)).start()
     * TypeScript: For self-contained example, we'll use async function
     *             (in production, use worker.Worker for true isolation)
     */
    async spawn(name: string, role: string, prompt: string): Promise<string> {
        await this.init();

        let member = this.findMember(name);
        if (member) {
            if (member.status !== "idle" && member.status !== "shutdown") {
                return `Error: '${name}' is currently ${member.status}`;
            }
            member.status = "working";
            member.role = role;
        } else {
            member = { name, role, status: "working" };
            this.config.members.push(member);
        }

        await this.saveConfig();

        // Start the teammate loop (async, non-blocking)
        this.teammateLoop(name, role, prompt).catch(() => {});

        return `Spawned '${name}' (role: ${role})`;
    }

    private async setStatus(name: string, status: TeamMember["status"]): Promise<void> {
        const member = this.findMember(name);
        if (member) {
            member.status = status;
            await this.saveConfig();
        }
    }

    /**
     * TYPESCRIPT VS PYTHON: Async agent loop for teammates
     * Python: Synchronous loop with threading
     * TypeScript: Async/await loop with proper error handling
     */
    private async teammateLoop(
        name: string,
        role: string,
        prompt: string
    ): Promise<void> {
        const teamName = this.config.team_name;
        const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle when done with current work. You may auto-claim tasks.`;

        let messages: Message[] = [
            { role: "user", content: prompt },
        ];

        const teammateTools = [
            {
                name: "bash",
                description: "Run command.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        command: { type: "string" as const },
                    },
                    required: ["command"],
                },
            },
            {
                name: "read_file",
                description: "Read file.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string" as const },
                    },
                    required: ["path"],
                },
            },
            {
                name: "write_file",
                description: "Write file.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string" as const },
                        content: { type: "string" as const } as any,
                    } as any,
                    required: ["path", "content"],
                },
            },
            {
                name: "edit_file",
                description: "Edit file.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        path: { type: "string" as const },
                        old_text: { type: "string" as const },
                        new_text: { type: "string" as const },
                    } as any,
                    required: ["path", "old_text", "new_text"],
                },
            },
            {
                name: "send_message",
                description: "Send message.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        to: { type: "string" as const },
                        content: { type: "string" as const } as any,
                    },
                    required: ["to", "content"],
                },
            },
            {
                name: "idle",
                description: "Signal no more work.",
                input_schema: {
                    type: "object" as const,
                    properties: {},
                },
            },
            {
                name: "claim_task",
                description: "Claim task by ID.",
                input_schema: {
                    type: "object" as const,
                    properties: {
                        task_id: { type: "integer" as const },
                    },
                    required: ["task_id"],
                },
            },
        ];

        // MAIN LOOP
        while (true) {
            // -- WORK PHASE --
            let idleRequested = false;

            for (let round = 0; round < 50; round++) {
                // Check inbox
                const inbox = await this.bus.readInbox(name);
                for (const msg of inbox) {
                    if (msg.type === "shutdown_request") {
                        await this.setStatus(name, "shutdown");
                        return;
                    }
                    messages.push({
                        role: "user",
                        content: JSON.stringify(msg),
                    });
                }

                // LLM call
                let response: Anthropic.Message;
                try {
                    response = await client.messages.create({
                        model: MODEL,
                        system: sysPrompt,
                        messages: messages as any,
                        tools: teammateTools as any,
                        max_tokens: 8000,
                    });
                } catch {
                    await this.setStatus(name, "shutdown");
                    return;
                }

                messages.push({
                    role: "assistant",
                    content: response.content as any,
                });

                if (response.stop_reason !== "tool_use") {
                    // Work phase complete
                    break;
                }

                // Execute tools
                const results: ToolResultBlockParam[] = [];
                for (const block of response.content) {
                    if (block.type === "tool_use") {
                        let output: string;
                        const input = (block as any).input || {};

                        if (block.name === "idle") {
                            idleRequested = true;
                            output = "Entering idle phase.";
                        } else if (block.name === "claim_task") {
                            output = await this.taskMgr.claim(
                                input.task_id as number,
                                name
                            );
                        } else if (block.name === "send_message") {
                            output = await this.bus.send(
                                name,
                                input.to as string,
                                input.content as string
                            );
                        } else if (block.name === "bash") {
                            output = await runBash(input.command as string);
                        } else if (block.name === "read_file") {
                            output = await runRead(input.path as string);
                        } else if (block.name === "write_file") {
                            output = await runWrite(
                                input.path as string,
                                input.content as string
                            );
                        } else if (block.name === "edit_file") {
                            output = await runEdit(
                                input.path as string,
                                input.old_text as string,
                                input.new_text as string
                            );
                        } else {
                            output = "Unknown tool";
                        }

                        console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
                        results.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: output,
                        });
                    }
                }

                messages.push({ role: "user", content: results as any });

                if (idleRequested) {
                    break;
                }
            }

            // -- IDLE PHASE: poll for messages and unclaimed tasks --
            await this.setStatus(name, "idle");
            let resume = false;

            for (let i = 0; i < IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1); i++) {
                await new Promise((resolve) =>
                    setTimeout(resolve, POLL_INTERVAL * 1000)
                );

                // Check inbox
                const inbox = await this.bus.readInbox(name);
                if (inbox.length > 0) {
                    for (const msg of inbox) {
                        if (msg.type === "shutdown_request") {
                            await this.setStatus(name, "shutdown");
                            return;
                        }
                        messages.push({
                            role: "user",
                            content: JSON.stringify(msg),
                        });
                    }
                    resume = true;
                    break;
                }

                // Check for unclaimed tasks
                const allTasks = await this.taskMgr.listAll();
                if (allTasks !== "No tasks.") {
                    const taskLines = allTasks.split("\n");
                    const pendingTasks: Task[] = [];

                    for (const line of taskLines) {
                        const match = line.match(/#(\d+):/);
                        if (match && line.includes("[ ]")) {
                            const taskId = parseInt(match[1], 10);
                            try {
                                const taskJson = await this.taskMgr.get(taskId);
                                const task = JSON.parse(taskJson) as Task;
                                if (
                                    task.status === "pending" &&
                                    !task.owner &&
                                    task.blockedBy.length === 0
                                ) {
                                    pendingTasks.push(task);
                                }
                            } catch {
                                // Task doesn't exist
                            }
                        }
                    }

                    if (pendingTasks.length > 0) {
                        const task = pendingTasks[0];
                        await this.taskMgr.claim(task.id, name);

                        // Identity re-injection for compressed contexts
                        if (messages.length <= 3) {
                            messages.unshift({
                                role: "user",
                                content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
                            });
                            messages.splice(1, 0, {
                                role: "assistant",
                                content: `I am ${name}. Continuing.`,
                            });
                        }

                        messages.push({
                            role: "user",
                            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description}</auto-claimed>`,
                        });
                        messages.push({
                            role: "assistant",
                            content: `Claimed task #${task.id}. Working on it.`,
                        });

                        resume = true;
                        break;
                    }
                }
            }

            if (!resume) {
                await this.setStatus(name, "shutdown");
                return;
            }

            await this.setStatus(name, "working");
        }
    }

    async listAll(): Promise<string> {
        await this.init();

        if (this.config.members.length === 0) {
            return "No teammates.";
        }

        const lines: string[] = [`Team: ${this.config.team_name}`];
        for (const m of this.config.members) {
            lines.push(`  ${m.name} (${m.role}): ${m.status}`);
        }
        return lines.join("\n");
    }

    memberNames(): string[] {
        return this.config.members.map((m) => m.name);
    }
}

// === SECTION: global_instances ===
// TYPESCRIPT VS PYTHON: Initialize instances after class definitions
// Python: Can instantiate at module level after class definitions
// TypeScript: Same pattern, works identically

const TODO = new TodoManager();
let SKILLS: SkillLoader;
let TASK_MGR: TaskManager;
let BG: BackgroundManager;
let BUS: MessageBus;
let TEAM: TeammateManager;

// === SECTION: system_prompt ===
async function buildSystemPrompt(): Promise<string> {
    const skillsDesc = SKILLS ? SKILLS.descriptions() : "(no skills)";
    return `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${skillsDesc}`;
}

let SYSTEM: string;

// === SECTION: shutdown_protocol (s10) ===
async function handleShutdownRequest(teammate: string): Promise<string> {
    const reqId = Math.random().toString(36).substring(2, 10);
    shutdownRequests.set(reqId, {
        target: teammate,
        status: "pending",
        from: "",
    });
    await BUS.send(
        "lead",
        teammate,
        "Please shut down.",
        "shutdown_request",
        { request_id: reqId }
    );
    return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10) ===
async function handlePlanReview(
    requestId: string,
    approve: boolean,
    feedback = ""
): Promise<string> {
    const req = planRequests.get(requestId);
    if (!req) {
        return `Error: Unknown plan request_id '${requestId}'`;
    }
    req.status = approve ? "approved" : "rejected";
    await BUS.send(
        "lead",
        req.from,
        feedback,
        "plan_approval_response",
        { request_id: requestId, approve, feedback }
    );
    return `Plan ${req.status} for '${req.from}'`;
}

// === SECTION: tool_dispatch (s02) ===
/**
 * TYPESCRIPT VS PYTHON: Type-safe tool handlers
 * Python: Lambda functions with **kw unpacking
 * TypeScript: Async functions with proper input types
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string> | string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => await runBash(input.command as string),
    read_file: async (input) => await runRead(input.path as string, input.limit as number | undefined),
    write_file: async (input) => await runWrite(input.path as string, input.content as string),
    edit_file: async (input) =>
        await runEdit(
            input.path as string,
            input.old_text as string,
            input.new_text as string
        ),
    TodoWrite: (input) =>
        TODO.update(input.items as TodoItem[]),
    task: async (input) =>
        await runSubagent(input.prompt as string, (input.agent_type as string) || "Explore"),
    load_skill: (input) => SKILLS.load(input.name as string),
    compress: () => "Compressing...",
    background_run: async (input) =>
        await BG.run(input.command as string, (input.timeout as number) || 120),
    check_background: (input) => BG.check(input.task_id as string | undefined),
    task_create: async (input) =>
        await TASK_MGR.create(input.subject as string, (input.description as string) || ""),
    task_get: async (input) => await TASK_MGR.get(input.task_id as number),
    task_update: async (input) =>
        await TASK_MGR.update(
            input.task_id as number,
            input.status as Task["status"] | undefined,
            input.add_blocked_by as number[] | undefined,
            input.remove_blocked_by as number[] | undefined
        ),
    task_list: async () => await TASK_MGR.listAll(),
    spawn_teammate: async (input) =>
        await TEAM.spawn(
            input.name as string,
            input.role as string,
            input.prompt as string
        ),
    list_teammates: async () => await TEAM.listAll(),
    send_message: async (input) =>
        await BUS.send(
            "lead",
            input.to as string,
            input.content as string,
            (input.msg_type as string) || "message"
        ),
    read_inbox: async () => JSON.stringify(await BUS.readInbox("lead"), null, 2),
    broadcast: async (input) =>
        await BUS.broadcast("lead", input.content as string, TEAM.memberNames()),
    shutdown_request: async (input) =>
        await handleShutdownRequest(input.teammate as string),
    plan_approval: async (input) =>
        await handlePlanReview(
            input.request_id as string,
            input.approve as boolean,
            (input.feedback as string) || ""
        ),
    idle: () => "Lead does not idle.",
    claim_task: async (input) =>
        await TASK_MGR.claim(input.task_id as number, "lead"),
};

const TOOLS = [
    { name: "bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] } },
    { name: "read_file", description: "Read file contents.", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, limit: { type: "integer" as const } }, required: ["path"] } },
    { name: "write_file", description: "Write content to file.", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, content: { type: "string" as const } }, required: ["path", "content"] } },
    { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } }, required: ["path", "old_text", "new_text"] } },
    { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object" as const, properties: { items: { type: "array" as const, items: { type: "object" as const, properties: { content: { type: "string" as const }, status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" as const } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
    { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object" as const, properties: { prompt: { type: "string" as const }, agent_type: { type: "string" as const, enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
    { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] } },
    { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object" as const, properties: {} } },
    { name: "background_run", description: "Run command in background thread.", input_schema: { type: "object" as const, properties: { command: { type: "string" as const }, timeout: { type: "integer" as const } }, required: ["command"] } },
    { name: "check_background", description: "Check background task status.", input_schema: { type: "object" as const, properties: { task_id: { type: "string" as const } } } },
    { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object" as const, properties: { subject: { type: "string" as const }, description: { type: "string" as const } }, required: ["subject"] } },
    { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] } },
    { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const }, status: { type: "string" as const, enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array" as const, items: { type: "integer" as const } }, remove_blocked_by: { type: "array" as const, items: { type: "integer" as const } } }, required: ["task_id"] } },
    { name: "task_list", description: "List all tasks.", input_schema: { type: "object" as const, properties: {} } },
    { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, role: { type: "string" as const }, prompt: { type: "string" as const } }, required: ["name", "role", "prompt"] } },
    { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object" as const, properties: {} } },
    { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object" as const, properties: { to: { type: "string" as const }, content: { type: "string" as const }, msg_type: { type: "string" as const, enum: Array.from(VALID_MSG_TYPES) } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object" as const, properties: {} } },
    { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object" as const, properties: { content: { type: "string" as const } }, required: ["content"] } },
    { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object" as const, properties: { teammate: { type: "string" as const } }, required: ["teammate"] } },
    { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, feedback: { type: "string" as const } }, required: ["request_id", "approve"] } },
    { name: "idle", description: "Enter idle state.", input_schema: { type: "object" as const, properties: {} } },
    { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] } },
];

// === SECTION: agent_loop ===
/**
 * TYPESCRIPT VS PYTHON: Async agent loop
 * Python: Synchronous while True loop
 * TypeScript: Async function with proper await handling
 */
async function agentLoop(messages: Message[]): Promise<void> {
    let roundsWithoutTodo = 0;

    while (true) {
        // s06: compression pipeline
        microcompact(messages);
        if (estimateTokens(messages) > TOKEN_THRESHOLD) {
            console.log("[auto-compact triggered]");
            messages.splice(0, messages.length, ...await autoCompact(messages));
        }

        // s08: drain background notifications
        const notifs = BG.drain();
        if (notifs.length > 0) {
            const txt = notifs
                .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
                .join("\n");
            messages.push({
                role: "user",
                content: `<background-results>\n${txt}\n</background-results>`,
            });
        }

        // s10: check lead inbox
        const inbox = await BUS.readInbox("lead");
        if (inbox.length > 0) {
            messages.push({
                role: "user",
                content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
            });
        }

        // LLM call
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages as any,
            tools: TOOLS as any,
            max_tokens: 8000,
        });

        messages.push({
            role: "assistant",
            content: response.content as any,
        });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        // Tool execution
        const results: (ToolResultBlockParam | { type: "text"; text: string })[] = [];
        let usedTodo = false;
        let manualCompress = false;

        for (const block of response.content) {
            if (block.type === "tool_use") {
                if (block.name === "compress") {
                    manualCompress = true;
                }

                const handler = TOOL_HANDLERS[block.name];
                let output: string;
                const input = (block as any).input || {};
                try {
                    output = handler
                        ? await handler(input)
                        : `Unknown tool: ${block.name}`;
                } catch (error) {
                    output = `Error: ${error instanceof Error ? error.message : "Unknown"}`;
                }

                console.log(`> ${block.name}:`);
                console.log(output.slice(0, 200));
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });

                if (block.name === "TodoWrite") {
                    usedTodo = true;
                }
            }
        }

        // s03: nag reminder (only when todo workflow is active)
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
            results.push({
                type: "text",
                text: "<reminder>Update your todos.</reminder>",
            });
        }

        messages.push({ role: "user", content: results as any });

        // s06: manual compress
        if (manualCompress) {
            console.log("[manual compact]");
            messages.splice(0, messages.length, ...await autoCompact(messages));
            return;
        }
    }
}

// === SECTION: repl ===
/**
 * TYPESCRIPT VS PYTHON: Async REPL
 * Python: input() for synchronous readline
 * TypeScript: Use readline/promises for async input
 */
import { createInterface } from "readline/promises";

async function main(): Promise<void> {
    // Initialize managers
    SKILLS = new SkillLoader(SKILLS_DIR);
    TASK_MGR = new TaskManager();
    BG = new BackgroundManager();
    BUS = new MessageBus();
    TEAM = new TeammateManager(BUS, TASK_MGR);
    SYSTEM = await buildSystemPrompt();

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const history: Message[] = [];

    console.log("Full Agent - Capstone combining sessions s01-s11");
    console.log("REPL commands: /compact /tasks /team /inbox");
    console.log("Type 'q', 'exit', or press Enter to quit\n");

    while (true) {
        try {
            const query = await rl.question("\x1b[36ms_full >> \x1b[0m");
            const trimmed = query.trim();

            if (trimmed.toLowerCase() === "q" || trimmed.toLowerCase() === "exit" || trimmed === "") {
                break;
            }

            if (trimmed === "/compact") {
                if (history.length > 0) {
                    console.log("[manual compact via /compact]");
                    history.splice(0, history.length, ...await autoCompact(history));
                }
                continue;
            }

            if (trimmed === "/tasks") {
                console.log(await TASK_MGR.listAll());
                continue;
            }

            if (trimmed === "/team") {
                console.log(await TEAM.listAll());
                continue;
            }

            if (trimmed === "/inbox") {
                console.log(JSON.stringify(await BUS.readInbox("lead"), null, 2));
                continue;
            }

            history.push({ role: "user", content: query });
            await agentLoop(history);
            console.log();
        } catch (error) {
            if ((error as any).name === "Exit") {
                break;
            }
            console.error("Error:", error);
        }
    }

    rl.close();
    console.log("\nGoodbye!");
}

// Run the main function
main().catch(console.error);
