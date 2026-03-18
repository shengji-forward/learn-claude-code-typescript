#!/usr/bin/env ts-node
// Harness: context isolation -- protecting the model's clarity of thought.
/**
 * s04_subagent.ts - Subagent
 *
 * Break big tasks down; each subtask gets a clean context.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";

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

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use tools to complete the task. For broad exploration, use the task tool once and wait for its summary.`;

const SUBAGENT_SYSTEM = `You are a focused subagent at ${WORKDIR}.
Use tools as needed and return a concise summary of findings and outcomes.`;

function safePath(p: string): string {
    const resolvedPath = path.resolve(WORKDIR, p);
    if (!resolvedPath.startsWith(WORKDIR)) {
        throw new Error(`Path escapes workspace: ${p}`);
    }
    return resolvedPath;
}

async function runBash(command: string): Promise<string> {
    const blocked = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (blocked.some((x) => command.includes(x))) {
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
        if (error?.code === "ETIMEDOUT") {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function runRead(filePath: string, limit?: number): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        const lines = content.split("\n");

        if (limit !== undefined && limit < lines.length) {
            const truncated = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
            return truncated.join("\n").slice(0, 50000);
        }

        return content.slice(0, 50000);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function runWrite(filePath: string, content: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        await fs.mkdir(path.dirname(safeFilePath), { recursive: true });
        await fs.writeFile(safeFilePath, content, "utf-8");
        return `Wrote ${content.length} bytes`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function runEdit(filePath: string, oldText: string, newText: string): Promise<string> {
    try {
        const safeFilePath = safePath(filePath);
        const content = await fs.readFile(safeFilePath, "utf-8");
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }
        await fs.writeFile(safeFilePath, content.replace(oldText, newText), "utf-8");
        return `Edited ${filePath}`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

type ToolHandler = (input: Record<string, any>) => Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
    bash: async (input) => runBash(input.command),
    read_file: async (input) => runRead(input.path, input.limit),
    write_file: async (input) => runWrite(input.path, input.content),
    edit_file: async (input) => runEdit(input.path, input.old_text, input.new_text),
};

const CHILD_TOOLS = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object" as const,
            properties: { command: { type: "string" as const } },
            required: ["command"] as const,
        },
    },
    {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
            type: "object" as const,
            properties: { path: { type: "string" as const }, limit: { type: "integer" as const } },
            required: ["path"] as const,
        },
    },
    {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
            type: "object" as const,
            properties: { path: { type: "string" as const }, content: { type: "string" as const } },
            required: ["path", "content"] as const,
        },
    },
    {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
            type: "object" as const,
            properties: {
                path: { type: "string" as const },
                old_text: { type: "string" as const },
                new_text: { type: "string" as const },
            },
            required: ["path", "old_text", "new_text"] as const,
        },
    },
];

const PARENT_TOOLS = [
    ...CHILD_TOOLS,
    {
        name: "task",
        description:
            "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
        input_schema: {
            type: "object" as const,
            properties: {
                prompt: { type: "string" as const },
                description: { type: "string" as const, description: "Short description of the task" },
            },
            required: ["prompt"] as const,
        },
    },
];

async function runSubagent(prompt: string): Promise<string> {
    const subMessages: any[] = [{ role: "user", content: prompt }];
    let finalResponse: any = null;

    for (let i = 0; i < 30; i += 1) {
        finalResponse = await client.messages.create({
            model: MODEL,
            system: SUBAGENT_SYSTEM,
            messages: subMessages,
            tools: CHILD_TOOLS as any,
            max_tokens: 8000,
        });

        subMessages.push({ role: "assistant", content: finalResponse.content as any });
        if (finalResponse.stop_reason !== "tool_use") {
            break;
        }

        const results: any[] = [];
        for (const block of finalResponse.content as any[]) {
            if (block.type === "tool_use") {
                const handler = TOOL_HANDLERS[block.name as string];
                const output = handler
                    ? await handler((block.input || {}) as Record<string, any>)
                    : `Unknown tool: ${block.name}`;
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: String(output).slice(0, 50000),
                });
            }
        }
        subMessages.push({ role: "user", content: results as any });
    }

    if (!finalResponse?.content) {
        return "(no summary)";
    }
    const text = (finalResponse.content as any[])
        .filter((b) => typeof b?.text === "string")
        .map((b) => b.text)
        .join("");
    return text || "(no summary)";
}

async function agentLoop(messages: any[]): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages,
            tools: PARENT_TOOLS as any,
            max_tokens: 8000,
        });

        messages.push({ role: "assistant", content: response.content as any });
        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results: any[] = [];
        for (const block of response.content as any[]) {
            if (block.type !== "tool_use") {
                continue;
            }

            let output: string;
            if (block.name === "task") {
                const desc = (block.input?.description as string) || "subtask";
                const prompt = (block.input?.prompt as string) || "";
                console.log(`> task (${desc}): ${prompt.slice(0, 80)}`);
                output = await runSubagent(prompt);
            } else {
                const handler = TOOL_HANDLERS[block.name as string];
                output = handler
                    ? await handler((block.input || {}) as Record<string, any>)
                    : `Unknown tool: ${block.name}`;
            }

            console.log(`  ${String(output).slice(0, 200)}`);
            results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: String(output),
            });
        }

        messages.push({ role: "user", content: results as any });
    }
}

async function main(): Promise<void> {
    const history: any[] = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 4: Subagent. Type 'q' to exit.\n");
    try {
        while (true) {
            const query = await question("\x1b[36ms04 >> \x1b[0m");
            if (query.trim().toLowerCase() === "q" || query.trim() === "") {
                break;
            }
            history.push({ role: "user", content: query });
            await agentLoop(history);
        }
    } finally {
        rl.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
