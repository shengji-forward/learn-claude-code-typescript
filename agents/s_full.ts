#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * s_full.ts — Full Reference Agent (TS capstone)
 *
 * Twelve-mechanism composition mirroring the Python s_full.py, plus s12
 * worktree-task isolation which the Python capstone defers to a separate
 * session. TS-only additions (archived under agents/extras/) are intentionally
 * NOT imported here; this file is the minimal "mainline" cockpit.
 *
 * Composed mechanisms:
 *   s01 agent loop        s07 task system (+ s12 worktree binding on Task)
 *   s02 tool dispatch     s08 background tasks (task-worker.ts)
 *   s03 TodoWrite         s09 agent teams (JSONL inboxes)
 *   s04 subagent          s10 team protocols (shutdown / plan approval)
 *   s05 skill loader      s11 autonomous teammates (idle -> auto-claim)
 *   s06 compression       s12 worktree task isolation (WorktreeManager)
 *
 * REPL commands: /compact /tasks /team /inbox /worktrees
 */

import Anthropic from "@anthropic-ai/sdk";
import { config as loadEnv } from "dotenv";
import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { Worker } from "worker_threads";
import { createInterface } from "readline/promises";

loadEnv({ override: true });
// When a custom base URL is set (e.g. a self-hosted proxy) the SDK's bearer
// auth token conflicts with the proxy's expectations, so drop it early.
if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const execAsync = promisify(exec);
// ESM-safe __dirname: workers are spawned by file path relative to this module.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

// Resolve repo root once so worktree operations stay inside the outer repo
// even when the agent is invoked from a subdirectory.
function detectRepoRoot(cwd: string): string {
    try {
        const out = execSync("git rev-parse --show-toplevel", {
            cwd, encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out || cwd;
    } catch {
        return cwd;
    }
}
const REPO_ROOT = detectRepoRoot(WORKDIR);

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const WORKTREES_DIR = path.join(REPO_ROOT, ".worktrees");
const EVENTS_PATH = path.join(WORKTREES_DIR, "events.jsonl");

const TOKEN_THRESHOLD = 100000;
const KEEP_RECENT = 3;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;
const VALID_MSG_TYPES = [
    "message", "broadcast", "shutdown_request",
    "shutdown_response", "plan_approval_response",
] as const;
// read_file outputs are reference material; clearing them forces the model
// to re-read. Keeping them alive costs tokens but prevents wasted re-reads.
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

type MessageParam = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlock;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

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
    worktree?: string;
    created_at?: number;
    updated_at?: number;
}

interface BgTask {
    status: "running" | "completed" | "error" | "timeout";
    command: string;
    result: string | null;
}

interface TeamMember {
    name: string;
    role: string;
    status: "working" | "idle" | "shutdown";
}

interface TeamConfig { team_name: string; members: TeamMember[]; }

interface Worktree {
    name: string;
    path: string;
    branch: string;
    task_id?: number;
    status: "active" | "removed" | "kept";
    created_at: number;
    kept_at?: number;
    removed_at?: number;
}

// === SECTION: base_tools (s02) ===
function safePath(p: string): string {
    const resolved = path.resolve(WORKDIR, p);
    // Re-derive boundary with a trailing sep so "/work" doesn't match "/workshop".
    const boundary = WORKDIR.endsWith(path.sep) ? WORKDIR : WORKDIR + path.sep;
    if (resolved !== WORKDIR && !resolved.startsWith(boundary)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolved;
}

async function runBash(command: string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: WORKDIR, timeout: 120000, maxBuffer: 50 * 1024 * 1024,
        });
        const out = (stdout + stderr).trim();
        return out ? out.slice(0, 50000) : "(no output)";
    } catch (err: any) {
        if (err?.killed || err?.code === "ETIMEDOUT") return "Error: Timeout (120s)";
        // Surface stderr from non-zero exits so the model sees the real failure.
        const combined = `${err?.stdout || ""}${err?.stderr || ""}`.trim();
        return combined ? combined.slice(0, 50000) : `Error: ${err?.message ?? "unknown"}`;
    }
}

async function runRead(p: string, limit?: number): Promise<string> {
    try {
        const lines = (await fs.readFile(safePath(p), "utf-8")).split("\n");
        const out = limit && limit < lines.length
            ? [...lines.slice(0, limit), `... (${lines.length - limit} more)`]
            : lines;
        return out.join("\n").slice(0, 50000);
    } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "unknown"}`;
    }
}

async function runWrite(p: string, content: string): Promise<string> {
    try {
        const fp = safePath(p);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, content);
        return `Wrote ${content.length} bytes to ${p}`;
    } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "unknown"}`;
    }
}

async function runEdit(p: string, oldText: string, newText: string): Promise<string> {
    try {
        const fp = safePath(p);
        const content = await fs.readFile(fp, "utf-8");
        if (!content.includes(oldText)) return `Error: Text not found in ${p}`;
        // Replace only the FIRST match — matches Python str.replace(x, y, 1)
        // and prevents accidental multi-site edits.
        await fs.writeFile(fp, content.replace(oldText, newText));
        return `Edited ${p}`;
    } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "unknown"}`;
    }
}

// === SECTION: TodoWrite (s03) ===
class TodoManager {
    private items: TodoItem[] = [];

    update(raw: unknown[]): string {
        const validated: TodoItem[] = [];
        let ip = 0;
        for (let i = 0; i < raw.length; i++) {
            const item = (raw[i] || {}) as Partial<TodoItem>;
            const content = String(item.content ?? "").trim();
            const status = String(item.status ?? "pending").toLowerCase() as TodoItem["status"];
            const activeForm = String(item.activeForm ?? "").trim();
            if (!content) throw new Error(`Item ${i}: content required`);
            if (!["pending", "in_progress", "completed"].includes(status))
                throw new Error(`Item ${i}: invalid status '${status}'`);
            if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
            if (status === "in_progress") ip++;
            validated.push({ content, status, activeForm });
        }
        if (validated.length > 20) throw new Error("Max 20 todos");
        if (ip > 1) throw new Error("Only one in_progress allowed");
        this.items = validated;
        return this.render();
    }

    render(): string {
        if (!this.items.length) return "No todos.";
        const mark = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };
        const lines = this.items.map((t) => {
            const suffix = t.status === "in_progress" ? ` <- ${t.activeForm}` : "";
            return `${mark[t.status] ?? "[?]"} ${t.content}${suffix}`;
        });
        const done = this.items.filter((t) => t.status === "completed").length;
        lines.push(`\n(${done}/${this.items.length} completed)`);
        return lines.join("\n");
    }

    hasOpenItems(): boolean {
        return this.items.some((t) => t.status !== "completed");
    }
}

// === SECTION: subagent (s04) ===
// Explore agents are intentionally read-only so the parent doesn't lose
// control of a runaway writer; general-purpose adds write/edit.
async function runSubagent(prompt: string, agentType = "Explore"): Promise<string> {
    const subTools: any[] = [
        { name: "bash", description: "Run command.",
          input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        { name: "read_file", description: "Read file.",
          input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ];
    if (agentType !== "Explore") {
        subTools.push(
            { name: "write_file", description: "Write file.",
              input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
            { name: "edit_file", description: "Edit file.",
              input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
        );
    }

    const subMessages: MessageParam[] = [{ role: "user", content: prompt }];
    let response: Anthropic.Message | null = null;
    // Bounded to 30 turns so a misbehaving subagent can't burn the budget.
    for (let i = 0; i < 30; i++) {
        response = await client.messages.create({
            model: MODEL, messages: subMessages, tools: subTools, max_tokens: 8000,
        });
        subMessages.push({ role: "assistant", content: response.content as any });
        if (response.stop_reason !== "tool_use") break;
        const results: ToolResultBlockParam[] = [];
        for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const inp = (block as any).input ?? {};
            let output: string;
            if (block.name === "bash") output = await runBash(inp.command);
            else if (block.name === "read_file") output = await runRead(inp.path, inp.limit);
            else if (block.name === "write_file") output = await runWrite(inp.path, inp.content);
            else if (block.name === "edit_file") output = await runEdit(inp.path, inp.old_text, inp.new_text);
            else output = `Unknown tool: ${block.name}`;
            results.push({
                type: "tool_result",
                tool_use_id: (block as any).id,
                content: String(output).slice(0, 50000),
            });
        }
        subMessages.push({ role: "user", content: results as any });
    }
    if (!response) return "(subagent failed)";
    return response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text).join("") || "(no summary)";
}

// === SECTION: skills (s05) ===
// Frontmatter is parsed with a small regex (not js-yaml) to keep the
// dependency surface identical to Python and to stay portable.
interface Skill { meta: Record<string, string>; body: string; }

class SkillLoader {
    private skills = new Map<string, Skill>();
    private ready: Promise<void>;

    constructor(private skillsDir: string) {
        this.ready = this.load().catch(() => {});
    }

    async whenReady(): Promise<void> { await this.ready; }

    private async walk(dir: string): Promise<string[]> {
        const out: string[] = [];
        let entries: Array<{ name: string; isDirectory(): boolean }>;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch { return out; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) out.push(...await this.walk(full));
            else if (e.name === "SKILL.md") out.push(full);
        }
        return out;
    }

    private async load(): Promise<void> {
        const files = (await this.walk(this.skillsDir)).sort();
        for (const file of files) {
            const text = await fs.readFile(file, "utf-8");
            const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
            const meta: Record<string, string> = {};
            let body = text;
            if (m) {
                for (const line of m[1].split("\n")) {
                    const idx = line.indexOf(":");
                    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                body = m[2].trim();
            }
            const name = meta.name || path.basename(path.dirname(file));
            this.skills.set(name, { meta, body });
        }
    }

    descriptions(): string {
        if (!this.skills.size) return "(no skills)";
        return Array.from(this.skills.entries())
            .map(([n, s]) => `  - ${n}: ${s.meta.description ?? "-"}`).join("\n");
    }

    loadSkill(name: string): string {
        const s = this.skills.get(name);
        if (!s) return `Error: Unknown skill '${name}'. Available: ${Array.from(this.skills.keys()).join(", ")}`;
        return `<skill name="${name}">\n${s.body}\n</skill>`;
    }
}

// === SECTION: compression (s06) ===
function estimateTokens(messages: MessageParam[]): number {
    // Rough 4-chars-per-token heuristic — same as Python.
    return Math.floor(JSON.stringify(messages, (_, v) => v?.toString?.() ?? v).length / 4);
}

// Micro-compact only mutates content IN PLACE; it must not drop entries,
// because tool_result ids must stay paired with their tool_use ids.
function microcompact(messages: MessageParam[]): void {
    const results: Array<{ content: unknown; tool_use_id?: string }> = [];
    for (const msg of messages) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const part of msg.content as any[]) {
            if (part?.type === "tool_result" && typeof part.content === "string") {
                results.push(part);
            }
        }
    }
    if (results.length <= KEEP_RECENT) return;
    const nameById = new Map<string, string>();
    for (const msg of messages) {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const block of msg.content as any[]) {
            if (block?.type === "tool_use" && block.id) nameById.set(block.id, block.name);
        }
    }
    for (const part of results.slice(0, -KEEP_RECENT)) {
        if (typeof part.content !== "string" || part.content.length <= 100) continue;
        const toolName = nameById.get(part.tool_use_id || "") || "unknown";
        if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;
        // Keep the tool name in the placeholder so the model can still
        // reason about "what did I do here" without the full payload.
        part.content = `[Previous: used ${toolName}]`;
    }
}

async function autoCompact(messages: MessageParam[]): Promise<MessageParam[]> {
    await fs.mkdir(TRANSCRIPT_DIR, { recursive: true });
    const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
    const dump = messages
        .map((m) => JSON.stringify(m, (_, v) => v?.toString?.() ?? v)).join("\n");
    await fs.writeFile(transcriptPath, dump);
    console.log(`[transcript saved: ${transcriptPath}]`);
    // Keep the tail of the conversation (most recent context) — the head
    // is already in the transcript file if the user needs to recover it.
    const convText = dump.slice(-80000);
    const resp = await client.messages.create({
        model: MODEL,
        messages: [{
            role: "user",
            content: "Summarize this conversation for continuity. Include: " +
                "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
                "Be concise but preserve critical details.\n\n" + convText,
        }],
        max_tokens: 2000,
    });
    const summary = resp.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text).join("") || "No summary generated.";
    return [{
        role: "user",
        content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    }];
}

// === SECTION: file_tasks (s07 + s12 worktree binding) ===
class TaskManager {
    private dir = TASKS_DIR;

    async init(): Promise<void> { await fs.mkdir(this.dir, { recursive: true }); }

    private async nextId(): Promise<number> {
        try {
            const files = await fs.readdir(this.dir);
            const ids = files
                .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
                .map((f) => parseInt(f.slice(5, -5), 10))
                .filter((n) => Number.isFinite(n));
            return ids.length ? Math.max(...ids) + 1 : 1;
        } catch { return 1; }
    }

    private taskPath(id: number): string { return path.join(this.dir, `task_${id}.json`); }

    private async load(id: number): Promise<Task> {
        try {
            return JSON.parse(await fs.readFile(this.taskPath(id), "utf-8")) as Task;
        } catch { throw new Error(`Task ${id} not found`); }
    }

    private async save(task: Task): Promise<void> {
        task.updated_at = Date.now() / 1000;
        await fs.writeFile(this.taskPath(task.id), JSON.stringify(task, null, 2));
    }

    async exists(id: number): Promise<boolean> {
        try { await fs.access(this.taskPath(id)); return true; } catch { return false; }
    }

    async create(subject: string, description = ""): Promise<string> {
        await this.init();
        const now = Date.now() / 1000;
        const task: Task = {
            id: await this.nextId(),
            subject, description,
            status: "pending", owner: null, blockedBy: [],
            worktree: "", created_at: now, updated_at: now,
        };
        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    async get(id: number): Promise<string> {
        return JSON.stringify(await this.load(id), null, 2);
    }

    async update(
        id: number, status?: Task["status"],
        addBlockedBy?: number[], removeBlockedBy?: number[], owner?: string,
    ): Promise<string> {
        const task = await this.load(id);
        if (status) {
            task.status = status;
            if (status === "completed") {
                // Cascade: unblock other tasks that depend on this one.
                const files = await fs.readdir(this.dir);
                for (const f of files) {
                    if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
                    const other = JSON.parse(await fs.readFile(path.join(this.dir, f), "utf-8")) as Task;
                    if (other.blockedBy?.includes(id)) {
                        other.blockedBy = other.blockedBy.filter((x) => x !== id);
                        await this.save(other);
                    }
                }
            }
            if (status === "deleted") {
                await fs.unlink(this.taskPath(id)).catch(() => {});
                return `Task ${id} deleted`;
            }
        }
        // blockedBy has a single source of truth (the task file itself); add
        // and remove lists are merged into a deduped array before save.
        if (addBlockedBy?.length) {
            task.blockedBy = Array.from(new Set([...(task.blockedBy ?? []), ...addBlockedBy]));
        }
        if (removeBlockedBy?.length) {
            task.blockedBy = (task.blockedBy ?? []).filter((x) => !removeBlockedBy.includes(x));
        }
        if (owner !== undefined) task.owner = owner;
        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    async listAll(): Promise<string> {
        await this.init();
        const files = (await fs.readdir(this.dir))
            .filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
        if (!files.length) return "No tasks.";
        const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
        const lines: string[] = [];
        for (const f of files) {
            const t = JSON.parse(await fs.readFile(path.join(this.dir, f), "utf-8")) as Task;
            const owner = t.owner ? ` @${t.owner}` : "";
            const wt = t.worktree ? ` wt=${t.worktree}` : "";
            const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
            lines.push(`${mark[t.status] ?? "[?]"} #${t.id}: ${t.subject}${owner}${wt}${blocked}`);
        }
        return lines.join("\n");
    }

    async claim(id: number, owner: string): Promise<string> {
        const task = await this.load(id);
        if (task.owner) return `Error: Task ${id} already claimed by ${task.owner}`;
        if (task.status !== "pending") return `Error: Task ${id} status is '${task.status}'`;
        if (task.blockedBy?.length) return `Error: Task ${id} is blocked by ${task.blockedBy.join(", ")}`;
        task.owner = owner;
        task.status = "in_progress";
        await this.save(task);
        return `Claimed task #${id} for ${owner}`;
    }

    async bindWorktree(id: number, worktree: string, owner = ""): Promise<string> {
        const task = await this.load(id);
        task.worktree = worktree;
        if (owner) task.owner = owner;
        if (task.status === "pending") task.status = "in_progress";
        await this.save(task);
        return JSON.stringify(task, null, 2);
    }

    async unbindWorktree(id: number): Promise<void> {
        const task = await this.load(id);
        task.worktree = "";
        await this.save(task);
    }
}

// === SECTION: worktree events + manager (s12) ===
class EventBus {
    constructor(private logPath: string) {}

    async init(): Promise<void> {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        try { await fs.access(this.logPath); } catch { await fs.writeFile(this.logPath, ""); }
    }

    async emit(event: string, task: Record<string, any> = {}, worktree: Record<string, any> = {}, error?: string): Promise<void> {
        const payload: any = { event, ts: Date.now() / 1000, task, worktree };
        if (error) payload.error = error;
        await fs.appendFile(this.logPath, JSON.stringify(payload) + "\n");
    }

    async listRecent(limit = 20): Promise<string> {
        const n = Math.max(1, Math.min(limit || 20, 200));
        try {
            const lines = (await fs.readFile(this.logPath, "utf-8"))
                .split("\n").filter((l) => l.trim()).slice(-n);
            return JSON.stringify(lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }), null, 2);
        } catch { return "[]"; }
    }
}

class WorktreeManager {
    private dir = WORKTREES_DIR;
    private indexPath = path.join(WORKTREES_DIR, "index.json");
    private gitAvailable = false;

    constructor(private repoRoot: string, private tasks: TaskManager, private events: EventBus) {}

    async init(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        try { await fs.access(this.indexPath); }
        catch { await fs.writeFile(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2)); }
        try {
            const { stdout } = await execAsync("git rev-parse --is-inside-work-tree", {
                cwd: this.repoRoot, timeout: 10000,
            });
            this.gitAvailable = stdout.trim() === "true";
        } catch { this.gitAvailable = false; }
    }

    isGitAvailable(): boolean { return this.gitAvailable; }

    private async loadIndex(): Promise<{ worktrees: Worktree[] }> {
        return JSON.parse(await fs.readFile(this.indexPath, "utf-8"));
    }
    private async saveIndex(idx: { worktrees: Worktree[] }): Promise<void> {
        await fs.writeFile(this.indexPath, JSON.stringify(idx, null, 2));
    }
    private async find(name: string): Promise<Worktree | undefined> {
        return (await this.loadIndex()).worktrees.find((w) => w.name === name);
    }
    private validateName(name: string): void {
        if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
            throw new Error("Invalid worktree name (1-40 chars: letters, digits, . _ -)");
        }
    }
    private async runGit(args: string[]): Promise<string> {
        if (!this.gitAvailable) throw new Error("Not in a git repository; worktree tools need git.");
        try {
            const { stdout, stderr } = await execAsync(`git ${args.join(" ")}`, {
                cwd: this.repoRoot, timeout: 120000,
            });
            return (stdout + stderr).trim() || "(no output)";
        } catch (err: any) {
            const msg = `${err?.stdout || ""}${err?.stderr || ""}`.trim();
            throw new Error(msg || `git ${args.join(" ")} failed`);
        }
    }

    async create(name: string, taskId?: number, baseRef = "HEAD"): Promise<string> {
        this.validateName(name);
        if (await this.find(name)) throw new Error(`Worktree '${name}' already exists`);
        if (taskId !== undefined && !(await this.tasks.exists(taskId))) {
            throw new Error(`Task ${taskId} not found`);
        }
        const wtPath = path.join(this.dir, name);
        const branch = `wt/${name}`;
        await this.events.emit("worktree.create.before",
            taskId !== undefined ? { id: taskId } : {},
            { name, base_ref: baseRef });
        try {
            await this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);
            const wt: Worktree = {
                name, path: wtPath, branch, task_id: taskId,
                status: "active", created_at: Date.now() / 1000,
            };
            const idx = await this.loadIndex();
            idx.worktrees.push(wt);
            await this.saveIndex(idx);
            if (taskId !== undefined) await this.tasks.bindWorktree(taskId, name);
            await this.events.emit("worktree.create.after",
                taskId !== undefined ? { id: taskId } : {},
                { name, path: wtPath, branch, status: "active" });
            return JSON.stringify(wt, null, 2);
        } catch (err: any) {
            await this.events.emit("worktree.create.failed",
                taskId !== undefined ? { id: taskId } : {},
                { name, base_ref: baseRef }, err instanceof Error ? err.message : String(err));
            throw err;
        }
    }

    async listAll(): Promise<string> {
        const wts = (await this.loadIndex()).worktrees;
        if (!wts.length) return "No worktrees in index.";
        return wts.map((w) => {
            const suffix = w.task_id !== undefined ? ` task=${w.task_id}` : "";
            return `[${w.status}] ${w.name} -> ${w.path} (${w.branch})${suffix}`;
        }).join("\n");
    }

    async status(name: string): Promise<string> {
        const wt = await this.find(name);
        if (!wt) return `Error: Unknown worktree '${name}'`;
        try { await fs.access(wt.path); } catch { return `Error: Worktree path missing: ${wt.path}`; }
        try {
            const { stdout, stderr } = await execAsync("git status --short --branch", {
                cwd: wt.path, timeout: 60000,
            });
            return (stdout + stderr).trim() || "Clean worktree";
        } catch (err: any) { return `Error: ${err?.message ?? "unknown"}`; }
    }

    async run(name: string, command: string): Promise<string> {
        const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
        if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
        const wt = await this.find(name);
        if (!wt) return `Error: Unknown worktree '${name}'`;
        try { await fs.access(wt.path); } catch { return `Error: Worktree path missing: ${wt.path}`; }
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: wt.path, timeout: 300000, maxBuffer: 50 * 1024 * 1024,
            });
            const out = (stdout + stderr).trim();
            return out ? out.slice(0, 50000) : "(no output)";
        } catch (err: any) {
            if (err?.code === "ETIMEDOUT") return "Error: Timeout (300s)";
            return `Error: ${err?.message ?? "unknown"}`;
        }
    }

    async keep(name: string): Promise<string> {
        const wt = await this.find(name);
        if (!wt) return `Error: Unknown worktree '${name}'`;
        const idx = await this.loadIndex();
        let kept: Worktree | undefined;
        for (const item of idx.worktrees) {
            if (item.name === name) { item.status = "kept"; item.kept_at = Date.now() / 1000; kept = item; }
        }
        await this.saveIndex(idx);
        await this.events.emit("worktree.keep",
            wt.task_id !== undefined ? { id: wt.task_id } : {},
            { name, path: wt.path, status: "kept" });
        return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
    }

    async remove(name: string, force = false, completeTask = false): Promise<string> {
        const wt = await this.find(name);
        if (!wt) return `Error: Unknown worktree '${name}'`;
        await this.events.emit("worktree.remove.before",
            wt.task_id !== undefined ? { id: wt.task_id } : {},
            { name, path: wt.path });
        try {
            const args = ["worktree", "remove"];
            if (force) args.push("--force");
            args.push(wt.path);
            await this.runGit(args);
            if (completeTask && wt.task_id !== undefined) {
                await this.tasks.update(wt.task_id, "completed");
                await this.tasks.unbindWorktree(wt.task_id);
            }
            const idx = await this.loadIndex();
            for (const item of idx.worktrees) {
                if (item.name === name) { item.status = "removed"; item.removed_at = Date.now() / 1000; }
            }
            await this.saveIndex(idx);
            await this.events.emit("worktree.remove.after",
                wt.task_id !== undefined ? { id: wt.task_id } : {},
                { name, path: wt.path, status: "removed" });
            return `Removed worktree '${name}'`;
        } catch (err: any) {
            await this.events.emit("worktree.remove.failed",
                wt.task_id !== undefined ? { id: wt.task_id } : {},
                { name, path: wt.path }, err instanceof Error ? err.message : String(err));
            throw err;
        }
    }
}

// === SECTION: background tasks (s08) ===
// Spawns task-worker.ts in a real Worker thread so long-running commands
// don't block the REPL. Notifications are drained before each LLM call.
class BackgroundManager {
    private tasks = new Map<string, BgTask>();
    private notifications: Array<{ task_id: string; status: string; result: string }> = [];

    async run(command: string, timeout = 120): Promise<string> {
        const taskId = Math.random().toString(36).slice(2, 10);
        this.tasks.set(taskId, { status: "running", command, result: null });
        const workerPath = path.resolve(__dirname, "task-worker.ts");
        const worker = new Worker(workerPath, {
            workerData: { taskId, command, workdir: WORKDIR, timeout: timeout * 1000 },
            execArgv: ["--loader", "ts-node/esm"],
        });
        worker.on("message", (data: { taskId: string; status: string; output: string }) => {
            const t = this.tasks.get(data.taskId);
            if (!t) return;
            t.status = (data.status === "completed" ? "completed" :
                        data.status === "timeout" ? "timeout" : "error") as BgTask["status"];
            t.result = data.output;
            this.notifications.push({
                task_id: data.taskId, status: t.status, result: data.output.slice(0, 500),
            });
            worker.terminate().catch(() => {});
        });
        worker.on("error", (err) => {
            const t = this.tasks.get(taskId);
            if (!t) return;
            t.status = "error";
            t.result = err?.message ?? "worker error";
            this.notifications.push({ task_id: taskId, status: "error", result: t.result.slice(0, 500) });
        });
        return `Background task ${taskId} started: ${command.slice(0, 80)}`;
    }

    check(taskId?: string): string {
        if (taskId) {
            const t = this.tasks.get(taskId);
            if (!t) return `Unknown: ${taskId}`;
            return `[${t.status}] ${t.result ?? "(running)"}`;
        }
        if (!this.tasks.size) return "No bg tasks.";
        return Array.from(this.tasks.entries())
            .map(([id, t]) => `${id}: [${t.status}] ${t.command.slice(0, 60)}`).join("\n");
    }

    drain(): Array<{ task_id: string; status: string; result: string }> {
        const out = this.notifications;
        this.notifications = [];
        return out;
    }
}

// === SECTION: messaging (s09) ===
class MessageBus {
    async init(): Promise<void> { await fs.mkdir(INBOX_DIR, { recursive: true }); }

    async send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): Promise<string> {
        await this.init();
        const msg = { type: msgType, from: sender, content, timestamp: Date.now() / 1000, ...(extra ?? {}) };
        await fs.appendFile(path.join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
        return `Sent ${msgType} to ${to}`;
    }

    async readInbox(name: string): Promise<Record<string, any>[]> {
        await this.init();
        const p = path.join(INBOX_DIR, `${name}.jsonl`);
        try {
            const text = await fs.readFile(p, "utf-8");
            const msgs = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
            // Drain-on-read so we don't re-deliver handled messages.
            await fs.writeFile(p, "");
            return msgs;
        } catch { return []; }
    }

    async broadcast(sender: string, content: string, names: string[]): Promise<string> {
        let count = 0;
        for (const n of names) {
            if (n === sender) continue;
            await this.send(sender, n, content, "broadcast");
            count++;
        }
        return `Broadcast to ${count} teammates`;
    }
}

// === SECTION: shutdown + plan tracking (s10) ===
interface ProtocolRequest { target?: string; from?: string; status: "pending" | "approved" | "rejected"; }
const shutdownRequests = new Map<string, ProtocolRequest>();
const planRequests = new Map<string, ProtocolRequest>();

// === SECTION: teammates (s09 / s11) ===
// Teammates run as concurrent async loops rather than as OS threads; they
// communicate through the JSONL inbox and pick up pending tasks on idle.
class TeammateManager {
    private configPath = path.join(TEAM_DIR, "config.json");
    private config: TeamConfig = { team_name: "default", members: [] };

    constructor(private bus: MessageBus, private taskMgr: TaskManager) {}

    async init(): Promise<void> {
        await fs.mkdir(TEAM_DIR, { recursive: true });
        try { this.config = JSON.parse(await fs.readFile(this.configPath, "utf-8")); }
        catch { this.config = { team_name: "default", members: [] }; }
    }

    private async saveConfig(): Promise<void> {
        await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
    }

    private find(name: string): TeamMember | undefined {
        return this.config.members.find((m) => m.name === name);
    }

    private async setStatus(name: string, status: TeamMember["status"]): Promise<void> {
        const m = this.find(name);
        if (m) { m.status = status; await this.saveConfig(); }
    }

    memberNames(): string[] { return this.config.members.map((m) => m.name); }

    async listAll(): Promise<string> {
        if (!this.config.members.length) return "No teammates.";
        return [
            `Team: ${this.config.team_name}`,
            ...this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`),
        ].join("\n");
    }

    async spawn(name: string, role: string, prompt: string): Promise<string> {
        await this.init();
        let member = this.find(name);
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
        // Fire-and-forget: we do NOT await the loop; REPL continues.
        this.loop(name, role, prompt).catch(() => {});
        return `Spawned '${name}' (role: ${role})`;
    }

    private teammateTools(): any[] {
        return [
            { name: "bash", description: "Run command.",
              input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
            { name: "read_file", description: "Read file.",
              input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
            { name: "write_file", description: "Write file.",
              input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
            { name: "edit_file", description: "Edit file.",
              input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
            { name: "send_message", description: "Send message.",
              input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
            { name: "idle", description: "Signal no more work.",
              input_schema: { type: "object", properties: {} } },
            { name: "claim_task", description: "Claim task by ID.",
              input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
        ];
    }

    private async loop(name: string, role: string, prompt: string): Promise<void> {
        const teamName = this.config.team_name;
        const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
            `Use idle when done with current work. You may auto-claim tasks.`;
        const messages: MessageParam[] = [{ role: "user", content: prompt }];
        const tools = this.teammateTools();

        while (true) {
            // -- WORK PHASE -- bounded so a stuck model doesn't livelock.
            let idleRequested = false;
            for (let round = 0; round < 50; round++) {
                const inbox = await this.bus.readInbox(name);
                for (const msg of inbox) {
                    if (msg.type === "shutdown_request") {
                        await this.setStatus(name, "shutdown");
                        return;
                    }
                    messages.push({ role: "user", content: JSON.stringify(msg) });
                }
                let response: Anthropic.Message;
                try {
                    response = await client.messages.create({
                        model: MODEL, system: sysPrompt, messages: messages as any,
                        tools, max_tokens: 8000,
                    });
                } catch {
                    await this.setStatus(name, "shutdown");
                    return;
                }
                messages.push({ role: "assistant", content: response.content as any });
                if (response.stop_reason !== "tool_use") break;
                const results: ToolResultBlockParam[] = [];
                for (const block of response.content) {
                    if (block.type !== "tool_use") continue;
                    const inp = (block as any).input ?? {};
                    let output: string;
                    if (block.name === "idle") { idleRequested = true; output = "Entering idle phase."; }
                    else if (block.name === "claim_task") output = await this.taskMgr.claim(inp.task_id, name);
                    else if (block.name === "send_message") output = await this.bus.send(name, inp.to, inp.content);
                    else if (block.name === "bash") output = await runBash(inp.command);
                    else if (block.name === "read_file") output = await runRead(inp.path, inp.limit);
                    else if (block.name === "write_file") output = await runWrite(inp.path, inp.content);
                    else if (block.name === "edit_file") output = await runEdit(inp.path, inp.old_text, inp.new_text);
                    else output = "Unknown tool";
                    console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
                    results.push({ type: "tool_result", tool_use_id: (block as any).id, content: String(output) });
                }
                messages.push({ role: "user", content: results as any });
                if (idleRequested) break;
            }

            // -- IDLE PHASE -- poll for messages and unclaimed tasks.
            await this.setStatus(name, "idle");
            let resume = false;
            const ticks = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
            for (let t = 0; t < ticks; t++) {
                await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));
                const inbox = await this.bus.readInbox(name);
                if (inbox.length) {
                    for (const msg of inbox) {
                        if (msg.type === "shutdown_request") {
                            await this.setStatus(name, "shutdown");
                            return;
                        }
                        messages.push({ role: "user", content: JSON.stringify(msg) });
                    }
                    resume = true;
                    break;
                }
                const files = (await fs.readdir(TASKS_DIR).catch(() => []))
                    .filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
                let pick: Task | undefined;
                for (const f of files) {
                    try {
                        const t = JSON.parse(await fs.readFile(path.join(TASKS_DIR, f), "utf-8")) as Task;
                        if (t.status === "pending" && !t.owner && !(t.blockedBy?.length)) { pick = t; break; }
                    } catch { /* skip malformed */ }
                }
                if (pick) {
                    await this.taskMgr.claim(pick.id, name);
                    // Identity re-injection: after a compaction the model may
                    // have lost its name/role, so we stamp it back in.
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
                        content: `<auto-claimed>Task #${pick.id}: ${pick.subject}\n${pick.description}</auto-claimed>`,
                    });
                    messages.push({ role: "assistant", content: `Claimed task #${pick.id}. Working on it.` });
                    resume = true;
                    break;
                }
            }
            if (!resume) { await this.setStatus(name, "shutdown"); return; }
            await this.setStatus(name, "working");
        }
    }
}

// === SECTION: global instances ===
const TODO = new TodoManager();
const TASK_MGR = new TaskManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const BG = new BackgroundManager();
const BUS = new MessageBus();
const EVENTS = new EventBus(EVENTS_PATH);
const WORKTREES = new WorktreeManager(REPO_ROOT, TASK_MGR, EVENTS);
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: shutdown / plan handlers (s10) ===
async function handleShutdownRequest(teammate: string): Promise<string> {
    const reqId = Math.random().toString(36).slice(2, 10);
    shutdownRequests.set(reqId, { target: teammate, status: "pending" });
    await BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
    return `Shutdown request ${reqId} sent to '${teammate}'`;
}

async function handlePlanReview(requestId: string, approve: boolean, feedback = ""): Promise<string> {
    const req = planRequests.get(requestId);
    if (!req) return `Error: Unknown plan request_id '${requestId}'`;
    req.status = approve ? "approved" : "rejected";
    await BUS.send("lead", req.from ?? "", feedback, "plan_approval_response",
        { request_id: requestId, approve, feedback });
    return `Plan ${req.status} for '${req.from}'`;
}

// === SECTION: tool dispatch (s02) ===
type ToolHandler = (input: any) => Promise<string> | string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: (i) => runBash(i.command),
    read_file: (i) => runRead(i.path, i.limit),
    write_file: (i) => runWrite(i.path, i.content),
    edit_file: (i) => runEdit(i.path, i.old_text, i.new_text),
    TodoWrite: (i) => TODO.update(i.items),
    task: (i) => runSubagent(i.prompt, i.agent_type ?? "Explore"),
    load_skill: (i) => SKILLS.loadSkill(i.name),
    // Manual compress handler returns a placeholder; the real work happens
    // AFTER tool results are appended in the agent loop (see manualCompress).
    compress: () => "Compressing...",
    background_run: (i) => BG.run(i.command, i.timeout ?? 120),
    check_background: (i) => BG.check(i.task_id),
    task_create: (i) => TASK_MGR.create(i.subject, i.description ?? ""),
    task_get: (i) => TASK_MGR.get(i.task_id),
    task_update: (i) => TASK_MGR.update(i.task_id, i.status, i.add_blocked_by, i.remove_blocked_by, i.owner),
    task_list: () => TASK_MGR.listAll(),
    task_bind_worktree: (i) => TASK_MGR.bindWorktree(i.task_id, i.worktree, i.owner ?? ""),
    worktree_create: (i) => WORKTREES.create(i.name, i.task_id, i.base_ref ?? "HEAD"),
    worktree_list: () => WORKTREES.listAll(),
    worktree_status: (i) => WORKTREES.status(i.name),
    worktree_run: (i) => WORKTREES.run(i.name, i.command),
    worktree_keep: (i) => WORKTREES.keep(i.name),
    worktree_remove: (i) => WORKTREES.remove(i.name, i.force ?? false, i.complete_task ?? false),
    worktree_events: (i) => EVENTS.listRecent(i.limit ?? 20),
    spawn_teammate: (i) => TEAM.spawn(i.name, i.role, i.prompt),
    list_teammates: () => TEAM.listAll(),
    send_message: (i) => BUS.send("lead", i.to, i.content, i.msg_type ?? "message"),
    read_inbox: async () => JSON.stringify(await BUS.readInbox("lead"), null, 2),
    broadcast: (i) => BUS.broadcast("lead", i.content, TEAM.memberNames()),
    shutdown_request: (i) => handleShutdownRequest(i.teammate),
    plan_approval: (i) => handlePlanReview(i.request_id, i.approve, i.feedback ?? ""),
    idle: () => "Lead does not idle.",
    claim_task: (i) => TASK_MGR.claim(i.task_id, "lead"),
};

const TOOLS: any[] = [
    { name: "bash", description: "Run a shell command.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file contents.",
      input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
    { name: "write_file", description: "Write content to file.",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "edit_file", description: "Replace exact text in file.",
      input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    { name: "TodoWrite", description: "Update task tracking list.",
      input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } },
          required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
    { name: "task", description: "Spawn a subagent for isolated exploration or work.",
      input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
    { name: "load_skill", description: "Load specialized knowledge by name.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "compress", description: "Manually compress conversation context.",
      input_schema: { type: "object", properties: {} } },
    { name: "background_run", description: "Run a command in a background worker thread.",
      input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
    { name: "check_background", description: "Check background task status.",
      input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
    { name: "task_create", description: "Create a persistent file-backed task.",
      input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
    { name: "task_get", description: "Get task details by ID.",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    { name: "task_update", description: "Update task status, owner, or blockedBy graph.",
      input_schema: { type: "object", properties: {
          task_id: { type: "integer" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
          owner: { type: "string" },
          add_blocked_by: { type: "array", items: { type: "integer" } },
          remove_blocked_by: { type: "array", items: { type: "integer" } },
      }, required: ["task_id"] } },
    { name: "task_list", description: "List all tasks.",
      input_schema: { type: "object", properties: {} } },
    { name: "task_bind_worktree", description: "Bind a task to a worktree name.",
      input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
    { name: "worktree_create", description: "Create a git worktree, optionally bound to a task.",
      input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
    { name: "worktree_list", description: "List worktrees from .worktrees/index.json.",
      input_schema: { type: "object", properties: {} } },
    { name: "worktree_status", description: "git status for one worktree.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "worktree_run", description: "Run a command in a named worktree.",
      input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
    { name: "worktree_keep", description: "Mark a worktree kept without removing.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "worktree_remove", description: "Remove a worktree; optionally complete its bound task.",
      input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
    { name: "worktree_events", description: "Recent worktree/task lifecycle events.",
      input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
    { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.",
      input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
    { name: "list_teammates", description: "List all teammates.",
      input_schema: { type: "object", properties: {} } },
    { name: "send_message", description: "Send a message to a teammate.",
      input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
    { name: "read_inbox", description: "Drain the lead's inbox.",
      input_schema: { type: "object", properties: {} } },
    { name: "broadcast", description: "Send a message to all teammates.",
      input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
    { name: "shutdown_request", description: "Request a teammate to shut down.",
      input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
    { name: "plan_approval", description: "Approve or reject a teammate's plan.",
      input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
    { name: "idle", description: "Enter idle state (lead ignores).",
      input_schema: { type: "object", properties: {} } },
    { name: "claim_task", description: "Claim a task from the board.",
      input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

// System prompt is built lazily so skills have time to finish loading.
async function buildSystem(): Promise<string> {
    await SKILLS.whenReady();
    return `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Use worktree_create/worktree_run for isolated parallel lanes; task_bind_worktree couples them.
Skills:
${SKILLS.descriptions()}`;
}

// === SECTION: agent loop (s01) ===
async function agentLoop(messages: MessageParam[], system: string): Promise<void> {
    let roundsWithoutTodo = 0;
    while (true) {
        microcompact(messages);
        if (estimateTokens(messages) > TOKEN_THRESHOLD) {
            console.log("[auto-compact triggered]");
            const compressed = await autoCompact(messages);
            messages.splice(0, messages.length, ...compressed);
        }
        // Surface background + inbox deltas as a single synthetic user turn
        // so we don't create adjacent user messages the API would flatten.
        const preamble: string[] = [];
        const notifs = BG.drain();
        if (notifs.length) {
            preamble.push("<background-results>\n" +
                notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n") +
                "\n</background-results>");
        }
        const inbox = await BUS.readInbox("lead");
        if (inbox.length) preamble.push(`<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`);
        if (preamble.length) messages.push({ role: "user", content: preamble.join("\n") });

        const response = await client.messages.create({
            model: MODEL, system, messages: messages as any,
            tools: TOOLS, max_tokens: 8000,
        });
        messages.push({ role: "assistant", content: response.content as any });
        if (response.stop_reason !== "tool_use") return;

        const results: Array<ToolResultBlockParam | { type: "text"; text: string }> = [];
        let usedTodo = false;
        let manualCompress = false;
        for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            if (block.name === "compress") manualCompress = true;
            const handler = TOOL_HANDLERS[block.name];
            let output: string;
            try {
                output = handler
                    ? String(await handler((block as any).input ?? {}))
                    : `Unknown tool: ${block.name}`;
            } catch (err) {
                output = `Error: ${err instanceof Error ? err.message : "unknown"}`;
            }
            // Label the output with its tool name so the REPL transcript stays
            // readable even when many tools fire in one turn.
            console.log(`> ${block.name}:`);
            console.log(output.slice(0, 200));
            results.push({ type: "tool_result", tool_use_id: (block as any).id, content: output });
            if (block.name === "TodoWrite") usedTodo = true;
        }

        // Nag reminder: APPEND (push) after the tool_results so the model sees
        // it on its NEXT turn — not before it finishes parsing the current
        // batch of results. Unshift would confuse that ordering.
        roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
        if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
            results.push({ type: "text", text: "<reminder>Update your todos.</reminder>" });
        }
        messages.push({ role: "user", content: results as any });

        if (manualCompress) {
            console.log("[manual compact]");
            const compressed = await autoCompact(messages);
            messages.splice(0, messages.length, ...compressed);
            return;
        }
    }
}

// === SECTION: REPL ===
async function main(): Promise<void> {
    await TASK_MGR.init();
    await BUS.init();
    await TEAM.init();
    await EVENTS.init();
    await WORKTREES.init();
    const system = await buildSystem();

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const history: MessageParam[] = [];

    console.log("s_full (TS capstone, s01–s12). REPL: /compact /tasks /team /inbox /worktrees. q to quit.");
    if (!WORKTREES.isGitAvailable()) {
        console.log("Note: Not inside a git repo — worktree_* tools will report errors.");
    }

    try {
        while (true) {
            const query = (await rl.question("\x1b[36ms_full >> \x1b[0m")).trim();
            if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") break;
            if (query === "/compact") {
                if (history.length) {
                    console.log("[manual compact via /compact]");
                    const compressed = await autoCompact(history);
                    history.splice(0, history.length, ...compressed);
                }
                continue;
            }
            if (query === "/tasks") { console.log(await TASK_MGR.listAll()); continue; }
            if (query === "/team") { console.log(await TEAM.listAll()); continue; }
            if (query === "/inbox") {
                console.log(JSON.stringify(await BUS.readInbox("lead"), null, 2));
                continue;
            }
            if (query === "/worktrees") { console.log(await WORKTREES.listAll()); continue; }

            history.push({ role: "user", content: query });
            await agentLoop(history, system);
            const last = history[history.length - 1]?.content;
            if (Array.isArray(last)) {
                for (const block of last as any[]) {
                    if (block?.type === "text" && typeof block.text === "string") {
                        console.log(block.text);
                    }
                }
            }
            console.log();
        }
    } finally {
        rl.close();
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
