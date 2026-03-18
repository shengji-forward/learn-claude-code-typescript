#!/usr/bin/env ts-node
// Harness: the loop -- the model's first connection to the real world.
// @ts-nocheck
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = await LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 *
 * === TYPESCRIPT VS PYTHON ===
 *
 * 1. ASYNC/AWAIT:
 *    - Python: Uses Anthropic's sync client by default
 *    - TypeScript: Must use async/await with the SDK
 *    - All SDK calls return Promises that must be awaited
 *
 * 2. TYPE SAFETY:
 *    - Python: Dynamic typing, runtime type checking
 *    - TypeScript: Compile-time type checking with interfaces
 *    - Content blocks use discriminated unions for type safety
 *
 * 3. MODULE SYSTEM:
 *    - Python: Uses import statements
 *    - TypeScript: Uses ES modules with .js extensions (required for Node.js ESM)
 *
 * 4. ENVIRONMENT:
 *    - Python: python-dotenv for .env files
 *    - TypeScript: Same dotenv package, but with typed config
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { exec } from "child_process";
import { promisify } from "util";
import * as readline from "readline";

// Load environment variables
// TypeScript: dotenv returns an object, we destructure to get config()
config();

// TypeScript: Must check for BASE_URL and handle auth token removal
// Python: os.getenv("ANTHROPIC_BASE_URL")
if (process.env.ANTHROPIC_BASE_URL) {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// Initialize Anthropic client
// TypeScript: new Anthropic() vs Python: Anthropic(base_url=...)
const client = new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL,
});

// TypeScript: const with type assertion vs Python: simple variable
const MODEL = process.env.MODEL_ID ?? (() => {
    throw new Error("MODEL_ID environment variable is required.");
})();

// TypeScript: Template literals work the same as Python f-strings
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// TypeScript: Interface for tool definition (compile-time type safety)
// Python: Dict with runtime structure only
interface BashTool {
    name: string;
    description: string;
    input_schema: {
        type: "object";
        properties: Record<string, { type: string }>;
        required: string[];
    };
}

// Define the bash tool
// TypeScript: Explicit const type vs Python's implicit dict
const TOOLS: BashTool[] = [
    {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
        },
    },
];

// Promisify exec for async/await
// Python: subprocess.run is synchronous (or uses asyncio)
// TypeScript: Node.js exec is callback-based, we promisify it
const execAsync = promisify(exec);

/**
 * Run a bash command with safety checks
 *
 * TypeScript: async function returning Promise<string>
 * Python: def run_bash(command: str) -> str (synchronous)
 *
 * Key differences:
 * - TypeScript uses async/await for non-blocking execution
 * - Type annotations are compile-time (stripped at runtime)
 * - Error handling with try/catch vs Python's exception handling
 */
async function runBash(command: string): Promise<string> {
    // TypeScript: Array of readonly strings (const assertion)
    // Python: List of strings
    const DANGEROUS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"] as const;

    // TypeScript: Array.some() with lambda
    // Python: any(d in command for d in dangerous)
    if (DANGEROUS.some((d) => command.includes(d))) {
        return "Error: Dangerous command blocked";
    }

    try {
        // TypeScript: Destructuring assignment
        // Python: r = subprocess.run(...); out = r.stdout + r.stderr
        const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            timeout: 120000, // 120 seconds in milliseconds
        });

        // TypeScript: Template literal with trim()
        // Python: (r.stdout + r.stderr).strip()
        const output = (stdout + stderr).trim();

        // TypeScript: Ternary operator
        // Python: out[:50000] if out else "(no output)"
        return output ? output.slice(0, 50000) : "(no output)";
    } catch (error) {
        // TypeScript: Type narrowing with instanceof
        // Python: except subprocess.TimeoutExpired
        if (error instanceof Error && "killed" in error) {
            return "Error: Timeout (120s)";
        }
        return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
}

/**
 * THE CORE PATTERN: Agent loop that calls tools until the model stops
 *
 * This is the heart of every AI coding agent. The loop:
 * 1. Sends messages + tools to the LLM
 * 2. Gets back response with tool_use calls
 * 3. Executes each tool, collects results
 * 4. Appends results as user message
 * 5. Loops back until model stops calling tools
 *
 * TypeScript: async function (returns Promise<void>)
 * Python: def agent_loop(messages: list) (returns None)
 *
 * Key differences:
 * - TypeScript must await all SDK calls
 * - Type-safe message handling with discriminated unions
 * - For...of loop vs Python's for block in response.content
 */
async function agentLoop(messages: Message[]): Promise<void> {
    // TypeScript: while loop with true (same as Python)
    while (true) {
        // TypeScript: await required for SDK call
        // Python: response = client.messages.create(...) (synchronous)
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens: 8000,
        });

        // Append assistant turn
        // TypeScript: Push to array with proper type
        // Python: messages.append({"role": "assistant", "content": response.content})
        messages.push({
            role: "assistant",
            content: response.content,
        });

        // If the model didn't call a tool, we're done
        // TypeScript: Strict equality check (=== vs ==)
        // Python: if response.stop_reason != "tool_use"
        if (response.stop_reason !== "tool_use") {
            return;
        }

        // Execute each tool call, collect results
        // TypeScript: Type annotation for array
        // Python: results = []
        const results: ToolResultBlock[] = [];

        // TypeScript: For...of loop (similar to Python's for block in...)
        for (const block of response.content) {
            // TypeScript: Type guard for discriminated union
            // Python: if block.type == "tool_use"
            if (block.type === "tool_use") {
                // TypeScript: ANSI color codes in template literal
                // Python: print(f"\033[33m$ {block.input['command']}\033[0m")
                console.log(`\x1b[33m$ ${block.input.command}\x1b[0m`);

                // TypeScript: Await async function call
                // Python: output = run_bash(block.input["command"])
                const output = await runBash(block.input.command);

                // TypeScript: String slicing
                // Python: print(output[:200])
                console.log(output.slice(0, 200));

                // TypeScript: Object with type-safe properties
                // Python: results.append({"type": "tool_result", ...})
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
        }

        // Append tool results as user message
        // TypeScript: Type-safe message object
        messages.push({
            role: "user",
            content: results,
        });
    }
}

/**
 * Types for message handling
 *
 * TypeScript: These interfaces define the shape of our data at compile time
 * Python: Would use dicts or TypedDict (runtime type hints only)
 */
interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

interface ContentBlock {
    type: string;
    [key: string]: unknown;
}

interface ToolUseBlock extends ContentBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: { command: string };
}

interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string;
}

/**
 * Main REPL loop
 *
 * TypeScript: async function with readline for input
 * Python: while True with input()
 *
 * Key differences:
 * - TypeScript uses readline/promises or readline.createInterface
 * - Python's built-in input() is synchronous
 * - Error handling with try/catch vs Python's except
 */
async function main(): Promise<void> {
    // TypeScript: Array of Message objects
    // Python: history = []
    const history: Message[] = [];

    // TypeScript: Create readline interface for user input
    // Python: Uses built-in input() function
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // TypeScript: Helper to prompt for input (promisified)
    // Python: query = input("s01 >> ")
    const question = (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            rl.question(prompt, resolve);
        });

    console.log("Session 1: Agent Loop. Type 'q' to exit.\n");

    // TypeScript: while loop (same as Python)
    while (true) {
        try {
            // TypeScript: await question() for async input
            // Python: query = input("\033[36ms01 >> \033[0m")
            const query = await question("\x1b[36ms01 >> \x1b[0m");

            // TypeScript: String trimming and lowercase
            // Python: if query.strip().lower() in ("q", "exit", "")
            if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
                break;
            }

            // Append user message
            // TypeScript: Type-safe push
            // Python: history.append({"role": "user", "content": query})
            history.push({
                role: "user",
                content: query,
            });

            // Run agent loop
            // TypeScript: await required
            // Python: agent_loop(history)
            await agentLoop(history);

            // Print response content
            // TypeScript: Type narrowing
            // Python: if isinstance(response_content, list)
            const responseContent = history[history.length - 1].content;
            if (Array.isArray(responseContent)) {
                for (const block of responseContent) {
                    // TypeScript: Check for text property
                    // Python: if hasattr(block, "text")
                    if ("text" in block && typeof block.text === "string") {
                        console.log(block.text);
                    }
                }
            }
            console.log();
        } catch (error) {
            // TypeScript: Error handling
            // Python: except (EOFError, KeyboardInterrupt)
            if (
                error instanceof Error &&
                (error.message.includes("EOF") || error.message.includes("SIGINT"))
            ) {
                break;
            }
            console.error("Error:", error);
        }
    }

    // TypeScript: Close readline interface
    rl.close();
}

// TypeScript: Run main function
// Python: if __name__ == "__main__": main()
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
