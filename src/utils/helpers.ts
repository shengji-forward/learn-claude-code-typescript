/**
 * Helper Functions
 *
 * Shared utility functions used throughout the agent system.
 *
 * Python vs TypeScript:
 * - Python: Built-in string methods, list comprehensions
 * - TypeScript: More explicit but type-safe utility functions
 * - Better type safety prevents runtime errors
 */

/**
 * Truncate a string to a maximum length
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @param suffix - Suffix to add if truncated (default: "...")
 * @returns Truncated string
 *
 * Python equivalent:
 * ```python
 * def truncate(s: str, max_len: int, suffix: str = "...") -> str:
 *     if len(s) <= max_len:
 *         return s
 *     return s[:max_len - len(suffix)] + suffix
 * ```
 */
export function truncate(
    str: string,
    maxLength: number,
    suffix: string = "..."
): string {
    if (str.length <= maxLength) {
        return str;
    }
    return str.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Split a string into lines with optional limit
 *
 * @param str - String to split
 * @param limit - Maximum number of lines (optional)
 * @returns Array of lines
 *
 * Python equivalent:
 * ```python
 * lines = text.splitlines()
 * if limit and limit < len(lines):
 *     lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]
 * ```
 */
export function splitLines(str: string, limit?: number): string[] {
    const lines = str.split("\n");

    if (limit !== undefined && limit < lines.length) {
        const truncated = lines.slice(0, limit);
        truncated.push(`... (${lines.length - limit} more lines)`);
        return truncated;
    }

    return lines;
}

/**
 * Format bytes to human-readable size
 *
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 KB", "2.3 MB")
 *
 * Python equivalent:
 * ```python
 * def format_bytes(bytes: int) -> str:
 *     for unit in ['B', 'KB', 'MB', 'GB']:
 *         if bytes < 1024:
 *             return f"{bytes:.1f} {unit}"
 *         bytes /= 1024
 * ```
 */
export function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format milliseconds to human-readable duration
 *
 * @param ms - Milliseconds
 * @returns Formatted string (e.g., "1.5s", "500ms")
 *
 * Python equivalent:
 * ```python
 * def format_duration(ms: int) -> str:
 *     if ms < 1000:
 *         return f"{ms}ms"
 *     return f"{ms/1000:.1f}s"
 * ```
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Sleep for a specified duration
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the duration
 *
 * Python equivalent:
 * ```python
 * import asyncio
 * await asyncio.sleep(ms / 1000)
 *
 * # or for synchronous:
 * import time
 * time.sleep(ms / 1000)
 * ```
 */
export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param baseDelay - Base delay in milliseconds (default: 1000)
 * @returns Promise resolving to function result
 * @throws Error if all retries fail
 *
 * Python equivalent:
 * ```python
 * import asyncio
 *
 * async def retry(fn, max_retries=3, base_delay=1):
 *     for attempt in range(max_retries):
 *         try:
 *             return await fn()
 *         except Exception as e:
 *             if attempt == max_retries - 1:
 *                 raise
 *             await asyncio.sleep(base_delay * (2 ** attempt))
 * ```
 */
export async function retry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, attempt);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

/**
 * Deep clone an object
 *
 * @param obj - Object to clone
 * @returns Cloned object
 *
 * Python equivalent:
 * ```python
 * import copy
 * cloned = copy.deepcopy(obj)
 * ```
 */
export function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Check if a value is defined (not null or undefined)
 *
 * @param value - Value to check
 * @returns true if value is defined, false otherwise
 *
 * Python equivalent:
 * ```python
 * if value is not None:
 *     # value is defined
 * ```
 */
export function isDefined<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
}

/**
 * Check if a string is empty or only whitespace
 *
 * @param str - String to check
 * @returns true if string is empty or whitespace
 *
 * Python equivalent:
 * ```python
 * if not str or str.isspace():
 *     # string is empty
 * ```
 */
export function isBlank(str: string | null | undefined): boolean {
    return !str || str.trim().length === 0;
}

/**
 * Generate a random ID
 *
 * @param prefix - Optional prefix for the ID
 * @returns Random ID string
 *
 * Python equivalent:
 * ```python
 * import uuid
 * return f"{prefix}_{uuid.uuid4().hex[:8]}"
 * ```
 */
export function generateId(prefix: string = ""): string {
    const random = Math.random().toString(36).substring(2, 10);
    return prefix ? `${prefix}_${random}` : random;
}

/**
 * Safe JSON parse with fallback
 *
 * @param str - String to parse
 * @param fallback - Fallback value if parsing fails
 * @returns Parsed object or fallback
 *
 * Python equivalent:
 * ```python
 * import json
 * try:
 *     return json.loads(s)
 * except json.JSONDecodeError:
 *     return fallback
 * ```
 */
export function safeJsonParse<T>(str: string, fallback: T): T {
    try {
        return JSON.parse(str) as T;
    } catch {
        return fallback;
    }
}

/**
 * Chunk an array into smaller arrays
 *
 * @param arr - Array to chunk
 * @param size - Chunk size
 * @returns Array of chunks
 *
 * Python equivalent:
 * ```python
 * def chunk(arr, size):
 *     return [arr[i:i + size] for i in range(0, len(arr), size)]
 * ```
 */
export function chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
