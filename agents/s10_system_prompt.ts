#!/usr/bin/env ts-node
// Harness: assembly -- the system prompt is a pipeline, not a string.
// @ts-nocheck
/**
 * s10_system_prompt.ts - System Prompt Construction
 *
 * This chapter teaches one core idea:
 * the system prompt should be assembled from clear sections, not written as one
 * giant hardcoded blob.
 *
 * Teaching pipeline:
 *   1. core instructions
 *   2. tool listing
 *   3. skill metadata
 *   4. memory section
 *   5. CLAUDE.md chain
 *   6. dynamic context
 *
 * The builder keeps stable information separate from information that changes
 * often. A simple DYNAMIC_BOUNDARY marker makes that split visible.
 *
 * Per-turn reminders are even more dynamic. They are better injected as a
 * separate user-role system reminder than mixed blindly into the stable prompt.
 *
 * Key insight: "Prompt construction is a pipeline with boundaries, not one
 * big string."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. FILE SYSTEM OPERATIONS:
 *    - Python: pathlib.Path with exists(), read_text(), iterdir(), glob()
 *    - TypeScript: fs.promises with readFile(), readdir(), stat()
 *    - TypeScript requires async/await for all file operations
 *
 * 2. REGEX MATCHING:
 *    - Python: re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
 *    - TypeScript: text.match(/^---\s*\n([\s\S]*?)\n---/, text)
 *    - TypeScript uses [\s\S] instead of re.DOTALL flag
 *
 * 3. CLASS CONSTRUCTION:
 *    - Python: class with __init__, self reference
 *    - TypeScript: class with constructor, this reference
 *    - TypeScript methods need explicit return types
 *
 * 4. OS INTEROP:
 *    - Python: os.uname().sysname
 *    - TypeScript: os.platform() or process.platform
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
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

const DYNAMIC_BOUNDARY = "=== DYNAMIC_BOUNDARY ===";

/**
 * SystemPromptBuilder - Assemble the system prompt from independent sections.
 *
 * The teaching goal here is clarity:
 * each section has one source and one responsibility.
 *
 * That makes the prompt easier to reason about, easier to test, and easier
 * to evolve as the agent grows new capabilities.
 *
 * TypeScript: class with typed properties and methods
 * Python: class SystemPromptBuilder with __init__
 */
class SystemPromptBuilder {
    private workdir: string;
    private tools: any[];
    private skillsDir: string;
    private memoryDir: string;

    constructor(workdir?: string, tools?: any[]) {
        this.workdir = workdir || WORKDIR;
        this.tools = tools || [];
        this.skillsDir = path.join(this.workdir, "skills");
        this.memoryDir = path.join(this.workdir, ".memory");
    }

    // -- Section 1: Core instructions --
    _buildCore(): string {
        return (
            `You are a coding agent operating in ${this.workdir}.\n` +
            "Use the provided tools to explore, read, write, and edit files.\n" +
            "Always verify before assuming. Prefer reading files over guessing."
        );
    }

    // -- Section 2: Tool listings --
    _buildToolListing(): string {
        if (!this.tools.length) {
            return "";
        }
        const lines = ["# Available tools"];
        for (const tool of this.tools) {
            const props = tool.input_schema?.properties || {};
            const params = Object.keys(props).join(", ");
            lines.push(`- ${tool.name}(${params}): ${tool.description}`);
        }
        return lines.join("\n");
    }

    // -- Section 3: Skill metadata (layer 1 from s05 concept) --
    async _buildSkillListing(): Promise<string> {
        try {
            const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
            const skills: string[] = [];

            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (!entry.isDirectory()) continue;
                const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
                let text: string;
                try {
                    text = await fs.readFile(skillMdPath, "utf-8");
                } catch {
                    continue;
                }

                // Parse frontmatter for name + description
                const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
                if (!match) continue;

                const meta: Record<string, string> = {};
                for (const line of match[1].split("\n")) {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx !== -1) {
                        const k = line.slice(0, colonIdx).trim();
                        const v = line.slice(colonIdx + 1).trim();
                        meta[k] = v;
                    }
                }
                const name = meta.name || entry.name;
                const desc = meta.description || "";
                skills.push(`- ${name}: ${desc}`);
            }

            if (!skills.length) return "";
            return "# Available skills\n" + skills.join("\n");
        } catch {
            return "";
        }
    }

    // -- Section 4: Memory content --
    async _buildMemorySection(): Promise<string> {
        try {
            const files = await fs.readdir(this.memoryDir);
            const mdFiles = files
                .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
                .sort();
            const memories: string[] = [];

            for (const fileName of mdFiles) {
                const mdFilePath = path.join(this.memoryDir, fileName);
                const text = await fs.readFile(mdFilePath, "utf-8");
                const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
                if (!match) continue;

                const header = match[1];
                const body = match[2].trim();
                const meta: Record<string, string> = {};
                for (const line of header.split("\n")) {
                    const colonIdx = line.indexOf(":");
                    if (colonIdx !== -1) {
                        const k = line.slice(0, colonIdx).trim();
                        const v = line.slice(colonIdx + 1).trim();
                        meta[k] = v;
                    }
                }
                const name = meta.name || path.basename(fileName, ".md");
                const memType = meta.type || "project";
                const desc = meta.description || "";
                memories.push(`[${memType}] ${name}: ${desc}\n${body}`);
            }

            if (!memories.length) return "";
            return "# Memories (persistent)\n\n" + memories.join("\n\n");
        } catch {
            return "";
        }
    }

    // -- Section 5: CLAUDE.md chain --
    async _buildClaudeMd(): Promise<string> {
        /**
         * Load CLAUDE.md files in priority order (all are included):
         * 1. ~/.claude/CLAUDE.md (user-global instructions)
         * 2. <project-root>/CLAUDE.md (project instructions)
         * 3. <current-subdir>/CLAUDE.md (directory-specific instructions)
         */
        const sources: [string, string][] = [];

        // User-global
        const userClaude = path.join(os.homedir(), ".claude", "CLAUDE.md");
        try {
            const content = await fs.readFile(userClaude, "utf-8");
            sources.push(["user global (~/.claude/CLAUDE.md)", content]);
        } catch { /* file doesn't exist */ }

        // Project root
        const projectClaude = path.join(this.workdir, "CLAUDE.md");
        try {
            const content = await fs.readFile(projectClaude, "utf-8");
            sources.push(["project root (CLAUDE.md)", content]);
        } catch { /* file doesn't exist */ }

        // Subdirectory -- in real CC, this walks from cwd up to project root
        // Teaching: check cwd if different from workdir
        const cwd = process.cwd();
        if (cwd !== this.workdir) {
            const subdirClaude = path.join(cwd, "CLAUDE.md");
            try {
                const content = await fs.readFile(subdirClaude, "utf-8");
                const dirName = path.basename(cwd);
                sources.push([`subdir (${dirName}/CLAUDE.md)`, content]);
            } catch { /* file doesn't exist */ }
        }

        if (!sources.length) return "";
        const parts = ["# CLAUDE.md instructions"];
        for (const [label, content] of sources) {
            parts.push(`## From ${label}`);
            parts.push(content.trim());
        }
        return parts.join("\n\n");
    }

    // -- Section 6: Dynamic context --
    _buildDynamicContext(): string {
        const lines = [
            `Current date: ${new Date().toISOString().split("T")[0]}`,
            `Working directory: ${this.workdir}`,
            `Model: ${MODEL}`,
            `Platform: ${process.platform}`,
        ];
        return "# Dynamic context\n" + lines.join("\n");
    }

    // -- Assemble all sections --
    async build(): Promise<string> {
        /**
         * Assemble the full system prompt from all sections.
         *
         * Static sections (1-5) are separated from dynamic (6) by
         * the DYNAMIC_BOUNDARY marker. In real CC, the static prefix
         * is cached across turns to save prompt tokens.
         */
        const sections: string[] = [];

        const core = this._buildCore();
        if (core) sections.push(core);

        const tools = this._buildToolListing();
        if (tools) sections.push(tools);

        const skills = await this._buildSkillListing();
        if (skills) sections.push(skills);

        const memory = await this._buildMemorySection();
        if (memory) sections.push(memory);

        const claudeMd = await this._buildClaudeMd();
        if (claudeMd) sections.push(claudeMd);

        // Static/dynamic boundary
        sections.push(DYNAMIC_BOUNDARY);

        const dynamic = this._buildDynamicContext();
        if (dynamic) sections.push(dynamic);

        return sections.join("\n\n");
    }
}

/**
 * Build a system-reminder user message for per-turn dynamic content.
 *
 * The teaching version keeps reminders outside the stable system prompt so
 * short-lived context does not get mixed into the long-lived instructions.
 *
 * TypeScript: Returns Message | null
 * Python: def build_system_reminder(extra: str = None) -> dict
 */
function buildSystemReminder(extra?: string): Message | null {
    const parts: string[] = [];
    if (extra) parts.push(extra);
    if (!parts.length) return null;
    const content = "<system-reminder>\n" + parts.join("\n") + "\n</system-reminder>";
    return { role: "user", content };
}

/**
 * Safe path validation
 * TypeScript: Returns string (absolute path)
 * Python: Returns Path object
 */
function safePath(filePath: string): string {
    const resolved = path.resolve(WORKDIR, filePath);
    const relative = path.relative(WORKDIR, resolved);

    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

const execAsync = promisify(exec);

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
    } catch (error) {
        if (error instanceof Error && "killed" in error) {
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
 * Types for message handling
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
 * Tool definitions for Anthropic API
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

// Global prompt builder
const promptBuilder = new SystemPromptBuilder(WORKDIR, TOOLS);

/**
 * Agent loop with assembled system prompt.
 *
 * The system prompt is rebuilt each iteration. In real CC, the static
 * prefix is cached and only the dynamic suffix changes per turn.
 *
 * TypeScript: async function
 * Python: def agent_loop(messages: list)
 */
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        // Rebuild system prompt each iteration
        // TypeScript: await async build method
        // Python: system = prompt_builder.build()
        const system = await promptBuilder.build();

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
            if (block.type === "tool_use" && block.id && block.name && block.input) {
                console.log(`> ${block.name}:`);

                const handler = TOOL_HANDLERS[block.name];
                let output: string;

                if (handler) {
                    try {
                        output = await handler(block.input);
                    } catch (error) {
                        output = `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
                    }
                } else {
                    output = `Unknown tool: ${block.name}`;
                }

                console.log(output.slice(0, 200));

                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
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
    // Show the assembled prompt at startup for educational purposes
    const fullPrompt = await promptBuilder.build();
    const sectionCount = fullPrompt.split("\n").filter((l) => l.startsWith("# ")).length;
    console.log(`[System prompt assembled: ${fullPrompt.length} chars, ~${sectionCount} sections]`);

    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 10: System Prompt Construction. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms10 >> \x1b[0m");

            if (
                query.trim().toLowerCase() === "q" ||
                query.trim().toLowerCase() === "exit" ||
                query.trim() === ""
            ) {
                break;
            }

            // /prompt command shows the full assembled prompt
            if (query.trim() === "/prompt") {
                console.log("--- System Prompt ---");
                console.log(await promptBuilder.build());
                console.log("--- End ---");
                continue;
            }

            // /sections command shows just the section headings
            if (query.trim() === "/sections") {
                const prompt = await promptBuilder.build();
                for (const line of prompt.split("\n")) {
                    if (line.startsWith("# ") || line === DYNAMIC_BOUNDARY) {
                        console.log(`  ${line}`);
                    }
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
