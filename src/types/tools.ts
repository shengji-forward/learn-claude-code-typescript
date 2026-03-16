/**
 * Tool Types for Agent Tool System
 *
 * Defines the interfaces for tool definitions and tool handlers.
 * These types provide type safety for the tool dispatch system.
 *
 * Python vs TypeScript:
 * - Python: TOOLS = [{"name": "bash", "input_schema": {...}}, ...]
 * - TypeScript: Tool[] array with proper interface typing
 * - Python: TOOL_HANDLERS = {"bash": lambda **kw: ...}
 * - TypeScript: ToolHandlerMap with typed handler functions
 */

/**
 * JSON Schema for tool input validation
 * Follows JSON Schema specification for tool parameters
 */
export interface ToolInputSchema {
    type: "object";
    properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
    }>;
    required: string[];
}

/**
 * Tool definition interface
 * Defines a tool that can be called by the agent
 * In Python: dict with name, description, input_schema keys
 */
export interface Tool {
    name: string;
    description: string;
    input_schema: ToolInputSchema;
}

/**
 * Tool handler function type
 * Functions that implement tool behavior
 * In Python: lambda **kwargs: str or def handler(**kwargs) -> str
 *
 * @param input - Tool input parameters (validated against input_schema)
 * @returns Promise resolving to tool output string
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string> | string;

/**
 * Map of tool names to their handlers
 * Provides type-safe dispatch from tool names to implementations
 * In Python: TOOL_HANDLERS = {"bash": lambda **kw: ..., "read": lambda **kw: ...}
 */
export type ToolHandlerMap = Record<string, ToolHandler>;

/**
 * Bash tool input parameters
 */
export interface BashInput {
    command: string;
}

/**
 * File read tool input parameters
 */
export interface ReadFileInput {
    path: string;
    limit?: number;
}

/**
 * File write tool input parameters
 */
export interface WriteFileInput {
    path: string;
    content: string;
}

/**
 * File edit tool input parameters
 */
export interface EditFileInput {
    path: string;
    old_text: string;
    new_text: string;
}

/**
 * Todo write tool input parameters
 */
export interface TodoWriteInput {
    todos: string[];
}

/**
 * Generic tool input union type
 * Can be extended as more tools are added
 */
export type ToolInput =
    | BashInput
    | ReadFileInput
    | WriteFileInput
    | EditFileInput
    | TodoWriteInput
    | Record<string, unknown>; // Fallback for unknown tools

/**
 * Type-safe tool execution context
 * Contains information needed during tool execution
 */
export interface ToolContext {
    workingDirectory: string;
    timeout?: number;
}
