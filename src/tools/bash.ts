/**
 * Bash Tool Handler
 *
 * Executes shell commands with safety checks.
 *
 * Python vs TypeScript:
 * - Python: subprocess.run(command, shell=True, ...)
 * - TypeScript: Uses Node.js child_process for command execution
 * - Async/await patterns instead of Python's sync/blocking calls
 * - Proper TypeScript types for parameters and return values
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Dangerous command patterns that should be blocked
 * In Python: dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
 */
const DANGEROUS_PATTERNS = [
    "rm -rf /",
    "rm -rf /*",
    "sudo",
    "shutdown",
    "reboot",
    "> /dev/",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",  // Fork bomb
] as const;

/**
 * Configuration for bash execution
 */
export interface BashConfig {
    /** Working directory for command execution */
    cwd?: string;
    /** Timeout in milliseconds (default: 120000 = 2 minutes) */
    timeout?: number;
    /** Maximum output size in characters (default: 50000) */
    maxOutput?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<BashConfig> = {
    cwd: process.cwd(),
    timeout: 120000,
    maxOutput: 50000,
};

/**
 * Check if a command contains dangerous patterns
 *
 * @param command - Command string to check
 * @returns true if command is dangerous, false otherwise
 *
 * Python equivalent:
 * ```python
 * dangerous = ["rm -rf /", "sudo", ...]
 * if any(d in command for d in dangerous):
 *     return True
 * ```
 */
export function isDangerousCommand(command: string): boolean {
    return DANGEROUS_PATTERNS.some((pattern) => command.includes(pattern));
}

/**
 * Execute a shell command with safety checks
 *
 * This is the TypeScript implementation of run_bash from the Python version.
 * Key differences:
 * - Uses async/await instead of synchronous execution
 * - Promisified child_process.exec for cleaner async code
 * - Proper TypeScript types for safety
 *
 * @param command - Shell command to execute
 * @param config - Execution configuration (optional)
 * @returns Promise resolving to command output
 *
 * Python equivalent:
 * ```python
 * def run_bash(command: str) -> str:
 *     dangerous = ["rm -rf /", "sudo", ...]
 *     if any(d in command for d in dangerous):
 *         return "Error: Dangerous command blocked"
 *     try:
 *         r = subprocess.run(command, shell=True, cwd=os.getcwd(),
 *                            capture_output=True, text=True, timeout=120)
 *         out = (r.stdout + r.stderr).strip()
 *         return out[:50000] if out else "(no output)"
 *     except subprocess.TimeoutExpired:
 *         return "Error: Timeout (120s)"
 * ```
 */
export async function runBash(
    command: string,
    config: BashConfig = {}
): Promise<string> {
    // Merge with defaults
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    // Check for dangerous commands
    if (isDangerousCommand(command)) {
        return "Error: Dangerous command blocked";
    }

    try {
        // Execute command with timeout
        const { stdout, stderr } = await execAsync(command, {
            cwd: finalConfig.cwd,
            timeout: finalConfig.timeout,
        });

        // Combine stdout and stderr, trim whitespace
        const output = (stdout + stderr).trim();

        // Return output or "(no output)" if empty
        if (!output) {
            return "(no output)";
        }

        // Truncate to max output size
        if (output.length > finalConfig.maxOutput) {
            return output.slice(0, finalConfig.maxOutput);
        }

        return output;
    } catch (error) {
        // Handle timeout
        if (error instanceof Error && "killed" in error && error.killed) {
            return `Error: Timeout (${finalConfig.timeout}ms)`;
        }

        // Handle other errors
        if (error instanceof Error) {
            return `Error: ${error.message}`;
        }

        return "Error: Unknown error occurred";
    }
}

/**
 * Create a bash tool definition for the agent
 *
 * @returns Tool object compatible with Anthropic API
 *
 * Python equivalent:
 * ```python
 * TOOLS = [{
 *     "name": "bash",
 *     "description": "Run a shell command.",
 *     "input_schema": {
 *         "type": "object",
 *         "properties": {"command": {"type": "string"}},
 *         "required": ["command"],
 *     },
 * }]
 * ```
 */
export function createBashTool() {
    return {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
            type: "object" as const,
            properties: {
                command: {
                    type: "string",
                },
            },
            required: ["command"] as const,
        },
    };
}
