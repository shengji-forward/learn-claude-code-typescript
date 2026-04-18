#!/usr/bin/env ts-node
// Harness: persistence -- remembering across the session boundary.
// @ts-nocheck
/**
 * s09_memory_system.ts - Memory System
 *
 * This teaching version focuses on one core idea:
 * some information should survive the current conversation, but not everything
 * belongs in memory.
 *
 * Use memory for:
 *   - user preferences
 *   - repeated user feedback
 *   - project facts that are NOT obvious from the current code
 *   - pointers to external resources
 *
 * Do NOT use memory for:
 *   - code structure that can be re-read from the repo
 *   - temporary task state
 *   - secrets
 *
 * Storage layout:
 *   .memory/
 *     MEMORY.md
 *     prefer_tabs.md
 *     review_style.md
 *     incident_board.md
 *
 * Each memory is a small Markdown file with frontmatter.
 * The agent can save a memory through save_memory(), and the memory index
 * is rebuilt after each write.
 *
 * An optional "Dream" pass can later consolidate, deduplicate, and prune
 * stored memories. It is useful, but it is not the first thing readers need
 * to understand.
 *
 * Key insight: "Memory only stores cross-session information that is still
 * worth recalling later and is not easy to re-derive from the current repo."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. FILE SYSTEM OPERATIONS:
 *    - Python: Path.read_text(), Path.write_text(), Path.mkdir()
 *    - TypeScript: await fs.readFile/writeFile/mkdir (all async)
 *    - TypeScript requires async/await for every file operation
 *
 * 2. DIRECTORY SCANNING:
 *    - Python: sorted(memory_dir.glob("*.md")) for file iteration
 *    - TypeScript: await fs.readdir() with filter + sort
 *    - Both produce sorted lists of matching files
 *
 * 3. FRONTMATTER PARSING:
 *    - Python: re.match() with DOTALL flag, manual key:value parsing
 *    - TypeScript: RegExp with 's' flag (or [\\s\\S]*), same parsing logic
 *    - Both return structured objects with name/description/type/content
 *
 * 4. PID-BASED LOCKING:
 *    - Python: os.getpid(), os.kill(pid, 0) for process check
 *    - TypeScript: process.pid, process.kill(pid, 0) for same
 *    - Both use signal-0 trick to check if a process is alive
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

const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];
const MAX_INDEX_LINES = 200;

interface MemoryEntry {
    description: string;
    type: MemoryType;
    content: string;
    file: string;
}

interface ParsedFrontmatter {
    name?: string;
    description?: string;
    type?: string;
    content: string;
}

/**
 * Load, build, and save persistent memories across sessions.
 *
 * The teaching version keeps memory explicit:
 * one Markdown file per memory, plus one compact index file.
 *
 * TypeScript: Class with async methods for all file operations
 * Python: class MemoryManager with sync file operations
 */
class MemoryManager {
    memoryDir: string;
    memories: Record<string, MemoryEntry>;

    constructor(memoryDir?: string) {
        this.memoryDir = memoryDir || MEMORY_DIR;
        this.memories = {};
    }

    /**
     * Load MEMORY.md index and all individual memory files.
     *
     * TypeScript: async method using fs.readdir + fs.readFile
     * Python: sync method using Path.glob + Path.read_text
     */
    async loadAll(): Promise<void> {
        this.memories = {};
        try {
            const files = await fs.readdir(this.memoryDir);
            const mdFiles = files
                .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
                .sort();

            for (const mdFile of mdFiles) {
                const filePath = path.join(this.memoryDir, mdFile);
                const text = await fs.readFile(filePath, "utf-8");
                const parsed = this._parseFrontmatter(text);
                if (parsed) {
                    const name = parsed.name || path.basename(mdFile, ".md");
                    this.memories[name] = {
                        description: parsed.description || "",
                        type: (parsed.type as MemoryType) || "project",
                        content: parsed.content || "",
                        file: mdFile,
                    };
                }
            }

            const count = Object.keys(this.memories).length;
            if (count > 0) {
                console.log(`[Memory loaded: ${count} memories from ${this.memoryDir}]`);
            }
        } catch {
            // Directory does not exist yet -- that is fine
        }
    }

    /**
     * Build a memory section for injection into the system prompt.
     *
     * TypeScript: Returns string with grouped memory content
     * Python: def load_memory_prompt(self) -> str
     */
    loadMemoryPrompt(): string {
        if (Object.keys(this.memories).length === 0) return "";

        const sections: string[] = [];
        sections.push("# Memories (persistent across sessions)");
        sections.push("");

        // Group by type for readability
        for (const memType of MEMORY_TYPES) {
            const typed = Object.entries(this.memories)
                .filter(([_, mem]) => mem.type === memType);
            if (typed.length === 0) continue;

            sections.push(`## [${memType}]`);
            for (const [name, mem] of typed) {
                sections.push(`### ${name}: ${mem.description}`);
                if (mem.content.trim()) {
                    sections.push(mem.content.trim());
                }
                sections.push("");
            }
        }

        return sections.join("\n");
    }

    /**
     * Save a memory to disk and update the index.
     *
     * Returns a status message.
     *
     * TypeScript: async method with fs.writeFile
     * Python: def save_memory(self, name, description, mem_type, content) -> str
     */
    async saveMemory(
        name: string,
        description: string,
        memType: string,
        content: string
    ): Promise<string> {
        if (!(MEMORY_TYPES as readonly string[]).includes(memType)) {
            return `Error: type must be one of ${MEMORY_TYPES.join(", ")}`;
        }

        // Sanitize name for filename
        // TypeScript: String replacement with regex
        // Python: re.sub(r"[^a-zA-Z0-9_-]", "_", name.lower())
        const safeName = name.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "_");
        if (!safeName) {
            return "Error: invalid memory name";
        }

        await fs.mkdir(this.memoryDir, { recursive: true });

        // Write individual memory file with frontmatter
        const frontmatter =
            `---\n` +
            `name: ${name}\n` +
            `description: ${description}\n` +
            `type: ${memType}\n` +
            `---\n` +
            `${content}\n`;

        const fileName = `${safeName}.md`;
        const filePath = path.join(this.memoryDir, fileName);
        await fs.writeFile(filePath, frontmatter, "utf-8");

        // Update in-memory store
        this.memories[name] = {
            description,
            type: memType as MemoryType,
            content,
            file: fileName,
        };

        // Rebuild MEMORY.md index
        await this._rebuildIndex();

        const relativePath = path.relative(WORKDIR, filePath);
        return `Saved memory '${name}' [${memType}] to ${relativePath}`;
    }

    /**
     * Rebuild MEMORY.md from current in-memory state, capped at 200 lines.
     *
     * TypeScript: async method with fs.writeFile
     * Python: def _rebuild_index(self)
     */
    async _rebuildIndex(): Promise<void> {
        const lines: string[] = ["# Memory Index", ""];

        for (const [name, mem] of Object.entries(this.memories)) {
            lines.push(`- ${name}: ${mem.description} [${mem.type}]`);
            if (lines.length >= MAX_INDEX_LINES) {
                lines.push(`... (truncated at ${MAX_INDEX_LINES} lines)`);
                break;
            }
        }

        await fs.mkdir(this.memoryDir, { recursive: true });
        await fs.writeFile(MEMORY_INDEX, lines.join("\n") + "\n", "utf-8");
    }

    /**
     * Parse --- delimited frontmatter + body content.
     *
     * TypeScript: RegExp with [\\s\\S]* for DOTALL equivalent
     * Python: re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
     */
    _parseFrontmatter(text: string): ParsedFrontmatter | null {
        const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
        if (!match) return null;

        const header = match[1];
        const body = match[2];
        const result: ParsedFrontmatter = { content: body.trim() };

        for (const line of header.split("\n")) {
            const colonIdx = line.indexOf(":");
            if (colonIdx !== -1) {
                const key = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim();
                (result as any)[key] = value;
            }
        }

        return result;
    }
}

/**
 * Auto-consolidation of memories between sessions ("Dream").
 *
 * This is an optional later-stage feature. Its job is to prevent the memory
 * store from growing into a noisy pile by merging, deduplicating, and
 * pruning entries over time.
 *
 * TypeScript: Class with async methods and process.pid for lock file
 * Python: class DreamConsolidator with os.getpid()
 */
class DreamConsolidator {
    static COOLDOWN_SECONDS = 86400;       // 24 hours between consolidations
    static SCAN_THROTTLE_SECONDS = 600;    // 10 minutes between scan attempts
    static MIN_SESSION_COUNT = 5;          // need enough data to consolidate
    static LOCK_STALE_SECONDS = 3600;      // PID lock considered stale after 1 hour

    static PHASES = [
        "Orient: scan MEMORY.md index for structure and categories",
        "Gather: read individual memory files for full content",
        "Consolidate: merge related memories, remove stale entries",
        "Prune: enforce 200-line limit on MEMORY.md index",
    ];

    memoryDir: string;
    lockFile: string;
    enabled: boolean;
    mode: string;
    lastConsolidationTime: number;
    lastScanTime: number;
    sessionCount: number;

    constructor(memoryDir?: string) {
        this.memoryDir = memoryDir || MEMORY_DIR;
        this.lockFile = path.join(this.memoryDir, ".dream_lock");
        this.enabled = true;
        this.mode = "default";
        this.lastConsolidationTime = 0;
        this.lastScanTime = 0;
        this.sessionCount = 0;
    }

    /**
     * Check 7 gates in sequence. All must pass.
     * Returns [canRun, reason] where reason explains the first failed gate.
     *
     * TypeScript: Returns [boolean, string] tuple
     * Python: Returns tuple[bool, str]
     */
    shouldConsolidate(): [boolean, string] {
        const now = Date.now() / 1000; // seconds

        // Gate 1: enabled flag
        if (!this.enabled) {
            return [false, "Gate 1: consolidation is disabled"];
        }

        // Gate 2: memory directory exists and has memory files
        // Note: synchronous check for gate validation; full async in consolidate()
        try {
            const files = require("fs").readdirSync(this.memoryDir) as string[];
            const memoryFiles = files.filter(
                (f: string) => f.endsWith(".md") && f !== "MEMORY.md"
            );
            if (memoryFiles.length === 0) {
                return [false, "Gate 2: no memory files found"];
            }
        } catch {
            return [false, "Gate 2: memory directory does not exist"];
        }

        // Gate 3: not in plan mode (only consolidate in active modes)
        if (this.mode === "plan") {
            return [false, "Gate 3: plan mode does not allow consolidation"];
        }

        // Gate 4: 24-hour cooldown since last consolidation
        const timeSinceLast = now - this.lastConsolidationTime;
        if (timeSinceLast < DreamConsolidator.COOLDOWN_SECONDS) {
            const remaining = Math.floor(DreamConsolidator.COOLDOWN_SECONDS - timeSinceLast);
            return [false, `Gate 4: cooldown active, ${remaining}s remaining`];
        }

        // Gate 5: 10-minute throttle since last scan attempt
        const timeSinceScan = now - this.lastScanTime;
        if (timeSinceScan < DreamConsolidator.SCAN_THROTTLE_SECONDS) {
            const remaining = Math.floor(DreamConsolidator.SCAN_THROTTLE_SECONDS - timeSinceScan);
            return [false, `Gate 5: scan throttle active, ${remaining}s remaining`];
        }

        // Gate 6: need at least 5 sessions worth of data
        if (this.sessionCount < DreamConsolidator.MIN_SESSION_COUNT) {
            return [false, `Gate 6: only ${this.sessionCount} sessions, need ${DreamConsolidator.MIN_SESSION_COUNT}`];
        }

        // Gate 7: no active lock file (check PID staleness)
        if (!this._acquireLock()) {
            return [false, "Gate 7: lock held by another process"];
        }

        return [true, "All 7 gates passed"];
    }

    /**
     * Run the 4-phase consolidation process.
     *
     * The teaching version returns phase descriptions to make the flow
     * visible without requiring an extra LLM pass here.
     *
     * TypeScript: Returns string[] of completed phases
     * Python: def consolidate(self) -> list[str]
     */
    async consolidate(): Promise<string[]> {
        const [canRun, reason] = this.shouldConsolidate();
        if (!canRun) {
            console.log(`[Dream] Cannot consolidate: ${reason}`);
            return [];
        }

        console.log("[Dream] Starting consolidation...");
        this.lastScanTime = Date.now() / 1000;

        const completedPhases: string[] = [];
        DreamConsolidator.PHASES.forEach((phase, i) => {
            console.log(`[Dream] Phase ${i + 1}/4: ${phase}`);
            completedPhases.push(phase);
        });

        this.lastConsolidationTime = Date.now() / 1000;
        this._releaseLock();
        console.log(`[Dream] Consolidation complete: ${completedPhases.length} phases executed`);
        return completedPhases;
    }

    /**
     * Acquire a PID-based lock file. Returns false if locked by another
     * live process. Stale locks (older than LOCK_STALE_SECONDS) are removed.
     *
     * TypeScript: Uses process.pid and process.kill(pid, 0)
     * Python: Uses os.getpid() and os.kill(pid, 0)
     */
    _acquireLock(): boolean {
        const now = Date.now() / 1000;

        try {
            const lockData = require("fs").readFileSync(this.lockFile, "utf-8").trim();
            const colonIdx = lockData.indexOf(":");
            if (colonIdx === -1) throw new Error("corrupted");

            const pid = parseInt(lockData.slice(0, colonIdx), 10);
            const lockTime = parseFloat(lockData.slice(colonIdx + 1));

            // Check if lock is stale
            if ((now - lockTime) > DreamConsolidator.LOCK_STALE_SECONDS) {
                console.log(`[Dream] Removing stale lock from PID ${pid}`);
                require("fs").unlinkSync(this.lockFile);
            } else {
                // Check if owning process is still alive
                try {
                    process.kill(pid, 0);
                    return false; // process alive, lock is valid
                } catch {
                    console.log(`[Dream] Removing lock from dead PID ${pid}`);
                    require("fs").unlinkSync(this.lockFile);
                }
            }
        } catch (e: any) {
            if (e.code !== "ENOENT" && e.message !== "corrupted") {
                // Corrupted lock file, remove it
                try {
                    require("fs").unlinkSync(this.lockFile);
                } catch { /* ignore */ }
            }
            // ENOENT means no lock file -- proceed
        }

        // Write new lock
        try {
            require("fs").mkdirSync(this.memoryDir, { recursive: true });
            require("fs").writeFileSync(this.lockFile, `${process.pid}:${now}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Release the lock file if we own it.
     *
     * TypeScript: Synchronous unlink for lock release
     * Python: def _release_lock(self)
     */
    _releaseLock(): void {
        try {
            const lockData = require("fs").readFileSync(this.lockFile, "utf-8").trim();
            const pidStr = lockData.split(":")[0];
            if (parseInt(pidStr, 10) === process.pid) {
                require("fs").unlinkSync(this.lockFile);
            }
        } catch {
            // Lock file gone or corrupted -- nothing to release
        }
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

// Global memory manager
const memoryMgr = new MemoryManager();

async function runSaveMemory(
    name: string,
    description: string,
    memType: string,
    content: string
): Promise<string> {
    return memoryMgr.saveMemory(name, description, memType, content);
}

/**
 * Tool handler type
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * THE DISPATCH MAP: Now includes save_memory handler!
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

    save_memory: async (input) => {
        const name = input.name as string;
        const description = input.description as string;
        const memType = input.type as string;
        const content = input.content as string;
        return runSaveMemory(name, description, memType, content);
    },
};

/**
 * Tool definitions - now includes save_memory!
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
    {
        name: "save_memory",
        description: "Save a persistent memory that survives across sessions.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: {
                    type: "string",
                    description: "Short identifier (e.g. prefer_tabs, db_schema)",
                },
                description: {
                    type: "string",
                    description: "One-line summary of what this memory captures",
                },
                type: {
                    type: "string",
                    description:
                        "user=preferences, feedback=corrections, project=non-obvious project conventions or decision reasons, reference=external resource pointers",
                },
                content: {
                    type: "string",
                    description: "Full memory content (multi-line OK)",
                },
            },
            required: ["name", "description", "type", "content"] as const,
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

const MEMORY_GUIDANCE = `
When to save memories:
- User states a preference ("I like tabs", "always use pytest") -> type: user
- User corrects you ("don't do X", "that was wrong because...") -> type: feedback
- You learn a project fact that is not easy to infer from current code alone
  (for example: a rule exists because of compliance, or a legacy module must
  stay untouched for business reasons) -> type: project
- You learn where an external resource lives (ticket board, dashboard, docs URL)
  -> type: reference

When NOT to save:
- Anything easily derivable from code (function signatures, file structure, directory layout)
- Temporary task state (current branch, open PR numbers, current TODOs)
- Secrets or credentials (API keys, passwords)
`;

/**
 * Assemble system prompt with memory content included.
 *
 * TypeScript: Returns string with memory section injected
 * Python: def build_system_prompt() -> str
 */
function buildSystemPrompt(): string {
    const parts = [`You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`];

    // Inject memory content if available
    const memorySection = memoryMgr.loadMemoryPrompt();
    if (memorySection) {
        parts.push(memorySection);
    }

    parts.push(MEMORY_GUIDANCE);
    return parts.join("\n\n");
}

/**
 * Agent loop with memory-aware system prompt.
 *
 * The system prompt is rebuilt each call so newly saved memories
 * are visible in the next LLM turn within the same session.
 *
 * TypeScript: async function rebuilding system prompt each call
 * Python: def agent_loop(messages)
 */
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        // Rebuild system prompt each call so new memories are visible
        const system = buildSystemPrompt();

        const response = await client.messages.create({
            model: MODEL,
            system: system,
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

            const handler = TOOL_HANDLERS[block.name];
            let output: string;
            try {
                output = handler
                    ? await handler(block.input || {})
                    : `Unknown: ${block.name}`;
            } catch (error) {
                output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
            }
            console.log(`> ${block.name}: ${output.slice(0, 200)}`);

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
    // Load existing memories at session start
    await memoryMgr.loadAll();
    const memCount = Object.keys(memoryMgr.memories).length;
    if (memCount) {
        console.log(`[${memCount} memories loaded into context]`);
    } else {
        console.log("[No existing memories. The agent can create them with save_memory.]");
    }

    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 9: Memory System. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms09 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                break;
            }

            // /memories command to list current memories
            if (query.trim() === "/memories") {
                if (Object.keys(memoryMgr.memories).length > 0) {
                    for (const [name, mem] of Object.entries(memoryMgr.memories)) {
                        console.log(`  [${mem.type}] ${name}: ${mem.description}`);
                    }
                } else {
                    console.log("  (no memories)");
                }
                continue;
            }

            history.push({
                role: "user",
                content: query,
            });

            await agentLoop(history);

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
