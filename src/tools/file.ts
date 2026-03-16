/**
 * File Tool Handlers
 *
 * Implements file read, write, and edit operations with safety checks.
 *
 * Python vs TypeScript:
 * - Python: pathlib.Path for file operations
 * - TypeScript: Node.js fs/promises module for async file operations
 * - Proper TypeScript types for file paths and contents
 * - Async/await throughout for non-blocking I/O
 */

import { promises as fs } from "fs";
import path from "path";

/**
 * Configuration for file operations
 */
export interface FileConfig {
    /** Working directory (files must be within this directory) */
    workingDirectory?: string;
    /** Maximum file size to read in bytes (default: 1MB) */
    maxFileSize?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<FileConfig> = {
    workingDirectory: process.cwd(),
    maxFileSize: 1024 * 1024, // 1MB
};

/**
 * Validate and resolve a file path safely
 *
 * Ensures the path doesn't escape the working directory (path traversal protection).
 *
 * @param filePath - Relative or absolute file path
 * @param config - File operation configuration
 * @returns Resolved, safe absolute path
 * @throws Error if path escapes working directory
 *
 * Python equivalent:
 * ```python
 * def safe_path(p: str) -> Path:
 *     path = (WORKDIR / p).resolve()
 *     if not path.is_relative_to(WORKDIR):
 *         raise ValueError(f"Path escapes workspace: {p}")
 *     return path
 * ```
 */
export function safePath(
    filePath: string,
    config: FileConfig = {}
): string {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    const resolved = path.resolve(finalConfig.workingDirectory, filePath);
    const relative = path.relative(finalConfig.workingDirectory, resolved);

    // Check if path escapes working directory
    if (relative.startsWith("..")) {
        throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolved;
}

/**
 * Read file contents with optional line limit
 *
 * @param filePath - Path to file to read
 * @param limit - Maximum number of lines to read (optional)
 * @param config - File operation configuration
 * @returns Promise resolving to file contents
 *
 * Python equivalent:
 * ```python
 * def run_read(path: str, limit: int = None) -> str:
 *     try:
 *         text = safe_path(path).read_text()
 *         lines = text.splitlines()
 *         if limit and limit < len(lines):
 *             lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]
 *         return "\n".join(lines)[:50000]
 *     except Exception as e:
 *         return f"Error: {e}"
 * ```
 */
export async function readFile(
    filePath: string,
    limit?: number,
    config: FileConfig = {}
): Promise<string> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    try {
        const safeFilePath = safePath(filePath, finalConfig);

        // Check file size before reading
        const stats = await fs.stat(safeFilePath);
        if (stats.size > finalConfig.maxFileSize) {
            return `Error: File too large (${stats.size} bytes, max ${finalConfig.maxFileSize})`;
        }

        const text = await fs.readFile(safeFilePath, "utf-8");
        const lines = text.split("\n");

        // Apply line limit if specified
        if (limit !== undefined && limit < lines.length) {
            const truncated = lines.slice(0, limit);
            truncated.push(`... (${lines.length - limit} more lines)`);
            return truncated.join("\n");
        }

        return text.slice(0, 50000); // Max 50KB output
    } catch (error) {
        if (error instanceof Error) {
            return `Error: ${error.message}`;
        }
        return "Error: Unknown error occurred";
    }
}

/**
 * Write content to a file
 *
 * Creates parent directories if they don't exist.
 *
 * @param filePath - Path to file to write
 * @param content - Content to write
 * @param config - File operation configuration
 * @returns Promise resolving to success message
 *
 * Python equivalent:
 * ```python
 * def run_write(path: str, content: str) -> str:
 *     try:
 *         fp = safe_path(path)
 *         fp.parent.mkdir(parents=True, exist_ok=True)
 *         fp.write_text(content)
 *         return f"Wrote {len(content)} bytes to {path}"
 *     except Exception as e:
 *         return f"Error: {e}"
 * ```
 */
export async function writeFile(
    filePath: string,
    content: string,
    config: FileConfig = {}
): Promise<string> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    try {
        const safeFilePath = safePath(filePath, finalConfig);

        // Create parent directories if they don't exist
        const directory = path.dirname(safeFilePath);
        await fs.mkdir(directory, { recursive: true });

        // Write file
        await fs.writeFile(safeFilePath, content, "utf-8");

        return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (error) {
        if (error instanceof Error) {
            return `Error: ${error.message}`;
        }
        return "Error: Unknown error occurred";
    }
}

/**
 * Edit file by replacing exact text match
 *
 * @param filePath - Path to file to edit
 * @param oldText - Text to replace (must be exact match)
 * @param newText - Replacement text
 * @param config - File operation configuration
 * @returns Promise resolving to success/error message
 *
 * Python equivalent:
 * ```python
 * def run_edit(path: str, old_text: str, new_text: str) -> str:
 *     try:
 *         fp = safe_path(path)
 *         content = fp.read_text()
 *         if old_text not in content:
 *             return f"Error: Text not found in {path}"
 *         fp.write_text(content.replace(old_text, new_text, 1))
 *         return f"Edited {path}"
 *     except Exception as e:
 *         return f"Error: {e}"
 * ```
 */
export async function editFile(
    filePath: string,
    oldText: string,
    newText: string,
    config: FileConfig = {}
): Promise<string> {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };

    try {
        const safeFilePath = safePath(filePath, finalConfig);
        const content = await fs.readFile(safeFilePath, "utf-8");

        // Check if old text exists
        if (!content.includes(oldText)) {
            return `Error: Text not found in ${filePath}`;
        }

        // Replace only first occurrence (like Python's replace with count=1)
        const newContent = content.replace(oldText, newText);

        // Write back
        await fs.writeFile(safeFilePath, newContent, "utf-8");

        return `Edited ${filePath}`;
    } catch (error) {
        if (error instanceof Error) {
            return `Error: ${error.message}`;
        }
        return "Error: Unknown error occurred";
    }
}

/**
 * Create tool definitions for file operations
 *
 * @returns Array of tool definitions compatible with Anthropic API
 *
 * Python equivalent:
 * ```python
 * TOOLS = [
 *     {"name": "read_file", "description": "Read file contents.",
 *      "input_schema": {...}},
 *     {"name": "write_file", "description": "Write content to file.",
 *      "input_schema": {...}},
 *     {"name": "edit_file", "description": "Replace exact text in file.",
 *      "input_schema": {...}},
 * ]
 * ```
 */
export function createFileTools() {
    return [
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
}
