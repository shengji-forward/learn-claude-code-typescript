/**
 * Message Types for Claude Agent Communication
 *
 * This file defines the core message types used throughout the agent system.
 * These types mirror the Anthropic API message structure but with TypeScript
 * type safety for enhanced developer experience.
 *
 * Python vs TypeScript:
 * - Python uses dict with string keys and duck typing
 * - TypeScript uses discriminated unions for compile-time type safety
 * - ContentBlock is a union type vs Python's dynamic typing
 */

/**
 * A text content block
 * In Python: {"type": "text", "text": "..."}
 */
export interface TextBlock {
    type: "text";
    text: string;
}

/**
 * A tool use content block
 * In Python: {"type": "tool_use", "id": "...", "name": "...", "input": {...}}
 */
export interface ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}

/**
 * A tool result content block
 * In Python: {"type": "tool_result", "tool_use_id": "...", "content": "..."}
 */
export interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content?: string;
    is_error?: boolean;
}

/**
 * Union type for all content block types
 * This is a discriminated union - the 'type' field determines which interface is active
 * In Python: This would be a dict with varying keys (duck typing)
 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * Base message interface
 */
export interface BaseMessage {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}

/**
 * User message with content
 * In Python: {"role": "user", "content": "..."} or {"role": "user", "content": [...]}
 */
export interface UserMessage extends BaseMessage {
    role: "user";
    content: string | ContentBlock[];
}

/**
 * Assistant message with content blocks
 * In Python: {"role": "assistant", "content": [block1, block2, ...]}
 */
export interface AssistantMessage extends BaseMessage {
    role: "assistant";
    content: ContentBlock[];
}

/**
 * Union type for all message types
 * In Python: Just a dict with role and content keys
 */
export type Message = UserMessage | AssistantMessage;

/**
 * Helper to check if a content block is a tool use block
 * Type guard for discriminated union narrowing
 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
    return block.type === "tool_use";
}

/**
 * Helper to check if a content block is a tool result block
 */
export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
    return block.type === "tool_result";
}

/**
 * Helper to check if a content block is a text block
 */
export function isTextBlock(block: ContentBlock): block is TextBlock {
    return block.type === "text";
}
