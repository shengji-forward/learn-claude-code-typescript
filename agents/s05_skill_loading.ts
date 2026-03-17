#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * s05_skill_loading.ts - Skills
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 *     Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 *     Layer 2 (on demand): full skill body in tool_result
 *
 *     skills/
 *       pdf/
 *         SKILL.md          <-- frontmatter (name, description) + body
 *       code-review/
 *         SKILL.md
 *
 *     System prompt:
 *     +--------------------------------------+
 *     | You are a coding agent.              |
 *     | Skills available:                    |
 *     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
 *     |   - code-review: Review code...      |
 *     +--------------------------------------+
 *
 *     When model calls load_skill("pdf"):
 *     +--------------------------------------+
 *     | tool_result:                         |
 *     | <skill>                              |
 *     |   Full PDF processing instructions   |  <-- Layer 2: full body
 *     |   Step 1: ...                        |
 *     |   Step 2: ...                        |
 *     | </skill>                             |
 *     +--------------------------------------+
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. YAML PARSING:
 *    - Python: Uses regex or PyYAML for frontmatter
 *    - TypeScript: Can use regex (like Python) or js-yaml library
 *    - This implementation uses regex for simplicity (no extra dependency)
 *
 * 2. FILE SYSTEM SCANNING:
 *    - Python: pathlib.Path.rglob("SKILL.md") for recursive search
 *    - TypeScript: fs.promises.readdir with recursive option or manual traversal
 *    - This implementation uses a simple recursive approach
 *
 * 3. TYPED FRONTMATTER:
 *    - Python: Dict with runtime keys
 *    - TypeScript: Interface with compile-time checking
 *    - Optional fields marked with ? operator
 *
 * 4. ERROR HANDLING:
 *    - Python: try/except with Exception
 *    - TypeScript: try/catch with proper error typing
 *    - Both return user-friendly error messages
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
const SKILLS_DIR = path.join(WORKDIR, "skills");
const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

/**
 * Skill metadata interface
 * TypeScript: Interface with optional fields
 * Python: Dict with runtime keys
 */
interface SkillMetadata {
    name?: string;
    description?: string;
    tags?: string;
    [key: string]: string | undefined;
}

/**
 * Skill data structure
 * TypeScript: Interface with explicit types
 * Python: Dict with nested structure
 */
interface Skill {
    meta: SkillMetadata;
    body: string;
    path: string;
}

/**
 * SkillLoader: Scan skills/<name>/SKILL.md with YAML frontmatter
 *
 * TypeScript: Class with typed properties and methods
 * Python: class SkillLoader with __init__ and methods
 *
 * Key differences:
 * - TypeScript uses async/await for file operations
 * - Constructor is async in pattern (using init method)
 * - Explicit property types for metadata and skills
 */
class SkillLoader {
    private skillsDir: string;
    private skills: Map<string, Skill> = new Map();

    constructor(skillsDir: string) {
        this.skillsDir = skillsDir;
    }

    /**
     * Initialize by loading all skills
     * TypeScript: async method (can't be async in constructor)
     * Python: __init__ calls self._load_all() (synchronous)
     */
    async init(): Promise<void> {
        await this.loadAll();
    }

    /**
     * Recursively find and load all SKILL.md files
     * TypeScript: async/await with fs.readdir
     * Python: pathlib.Path.rglob("SKILL.md") (synchronous)
     */
    private async loadAll(): Promise<void> {
        try {
            await this.scanDirectory(this.skillsDir);
        } catch (error) {
            // Directory doesn't exist or isn't readable
            if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
                console.error("Error loading skills:", error);
            }
        }
    }

    /**
     * Recursively scan directory for SKILL.md files
     * TypeScript: Manual recursive implementation
     * Python: rglob does this automatically
     */
    private async scanDirectory(dir: string): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await this.scanDirectory(fullPath);
                } else if (entry.name === "SKILL.md") {
                    await this.loadSkillFile(fullPath);
                }
            }
        } catch (error) {
            // Skip directories we can't read
        }
    }

    /**
     * Load a single skill file
     */
    private async loadSkillFile(filePath: string): Promise<void> {
        try {
            const text = await fs.readFile(filePath, "utf-8");
            const { meta, body } = this.parseFrontmatter(text);
            const name = meta.name || path.basename(path.dirname(filePath));
            this.skills.set(name, {
                meta,
                body,
                path: filePath,
            });
        } catch (error) {
            console.error(`Error loading skill ${filePath}:`, error);
        }
    }

    /**
     * Parse YAML frontmatter between --- delimiters
     * TypeScript: RegExp with DOTALL flag (s in regex)
     * Python: re.match(r"^---\n(.*?)\n---\n(.*)", text, re.DOTALL)
     *
     * Note: This is a simple YAML parser. For production,
     * use the 'yaml' or 'js-yaml' package for full YAML support.
     */
    private parseFrontmatter(text: string): { meta: SkillMetadata; body: string } {
        // TypeScript: RegExp with /s flag for DOTALL
        // Python: re.DOTALL flag
        const match = text.match(/^---\n(.*?)\n---\n(.*)/s);

        if (!match) {
            return { meta: {}, body: text };
        }

        const meta: SkillMetadata = {};
        const frontmatterLines = match[1].trim().split("\n");

        // TypeScript: for...of loop for iteration
        // Python: for line in match.group(1).strip().splitlines()
        for (const line of frontmatterLines) {
            // TypeScript: String includes() method
            // Python: if ":" in line
            if (line.includes(":")) {
                // TypeScript: String split with limit
                // Python: key, val = line.split(":", 1)
                const colonIndex = line.indexOf(":");
                const key = line.slice(0, colonIndex).trim();
                const val = line.slice(colonIndex + 1).trim();
                meta[key] = val;
            }
        }

        return {
            meta,
            body: match[2].trim(),
        };
    }

    /**
     * Layer 1: Short descriptions for the system prompt
     * TypeScript: Returns string
     * Python: def get_descriptions(self) -> str
     */
    getDescriptions(): string {
        if (this.skills.size === 0) {
            return "(no skills available)";
        }

        const lines: string[] = [];

        // TypeScript: for...of with Map.entries()
        // Python: for name, skill in self.skills.items()
        for (const [name, skill] of this.skills.entries()) {
            const desc = skill.meta.description || "No description";
            const tags = skill.meta.tags || "";
            let line = `  - ${name}: ${desc}`;
            if (tags) {
                line += ` [${tags}]`;
            }
            lines.push(line);
        }

        return lines.join("\n");
    }

    /**
     * Layer 2: Full skill body returned in tool_result
     * TypeScript: Returns formatted string with XML tags
     * Python: f"<skill name=\"{name}\">\n{skill['body']}\n</skill>"
     */
    getContent(name: string): string {
        const skill = this.skills.get(name);

        if (!skill) {
            const available = Array.from(this.skills.keys()).join(", ");
            return `Error: Unknown skill '${name}'. Available: ${available}`;
        }

        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }

    /**
     * Get list of available skill names
     */
    getSkillNames(): string[] {
        return Array.from(this.skills.keys());
    }
}

/**
 * Initialize skill loader
 * TypeScript: await async initialization
 * Python: SKILL_LOADER = SkillLoader(SKILLS_DIR) (synchronous)
 */
const SKILL_LOADER = new SkillLoader(SKILLS_DIR);
SKILL_LOADER.init().catch((error) => {
    console.error("Failed to initialize skill loader:", error);
});

/**
 * Layer 1: Skill metadata injected into system prompt
 * TypeScript: Template literal with async loader
 * Python: f-string with method call
 */
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

/**
 * Tool implementations (same as s04)
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
 * Tool handler type
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * THE DISPATCH MAP: Now includes load_skill handler!
 *
 * TypeScript: Record with load_skill handler
 * Python: TOOL_HANDLERS = {..., "load_skill": lambda **kw: SKILL_LOADER.get_content(kw["name"])}
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

    // TypeScript: Skill loader handler
    // Python: lambda **kw: SKILL_LOADER.get_content(kw["name"])
    load_skill: async (input) => {
        const name = input.name as string;
        return SKILL_LOADER.getContent(name);
    },
};

/**
 * Tool definitions - now includes load_skill!
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
        name: "load_skill",
        description: "Load specialized knowledge by name.",
        input_schema: {
            type: "object" as const,
            properties: {
                name: {
                    type: "string",
                    description: "Skill name to load",
                },
            },
            required: ["name"] as const,
        },
    },
];

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
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

/**
 * Agent loop (same as s04)
 */
async function agentLoop(messages: Message[]): Promise<void> {
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
    const history: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 5: Skill Loading. Type 'q' to exit.\n");

    while (true) {
        try {
            const query = await question("\x1b[36ms05 >> \x1b[0m");

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
