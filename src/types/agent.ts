/**
 * Core Agent Types
 *
 * Defines the fundamental types for AI agents in this system.
 * These types provide the foundation for all agent implementations.
 *
 * Python vs TypeScript:
 * - Python uses classes and inheritance heavily
 * - TypeScript uses interfaces and composition patterns
 * - Type safety prevents many runtime errors through compile-time checks
 */

import type { Message } from "./messages.js";
import type { Tool, ToolHandlerMap } from "./tools.js";

/**
 * Agent configuration options
 * In Python: Typically passed as kwargs to __init__
 */
export interface AgentConfig {
    /** Anthropic API model ID (e.g., "claude-sonnet-4-6") */
    model: string;
    /** System prompt for the agent */
    systemPrompt: string;
    /** Tools available to the agent */
    tools: Tool[];
    /** Map of tool names to handler functions */
    toolHandlers: ToolHandlerMap;
    /** Maximum tokens in model response */
    maxTokens?: number;
    /** Working directory for file operations */
    workingDirectory?: string;
}

/**
 * Agent response metadata
 * Contains information about the model's response
 */
export interface AgentResponse {
    /** Content blocks returned by the model */
    content: Message["content"];
    /** Reason the model stopped generating */
    stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
    /** Model usage information */
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}

/**
 * Agent interface
 * Defines the contract for all agent implementations
 * In Python: This would be an abstract base class (ABC)
 */
export interface Agent {
    /**
     * The agent's main loop
     * Processes messages and executes tools until complete
     *
     * @param messages - Conversation history
     * @returns Promise resolving when the agent completes
     */
    run(messages: Message[]): Promise<void>;

    /**
     * Get the agent's configuration
     * @returns Current agent configuration
     */
    getConfig(): AgentConfig;
}

/**
 * Subagent configuration
 * Extends AgentConfig with subagent-specific options
 */
export interface SubagentConfig extends AgentConfig {
    /** If true, creates isolated context for subagent */
    isolateContext?: boolean;
    /** Parent agent reference (for context isolation) */
    parent?: Agent;
}

/**
 * Subagent interface
 * Agents that can be spawned as isolated workers
 * In Python: Would inherit from Agent with additional methods
 */
export interface Subagent extends Agent {
    /**
     * Execute subagent with isolated message context
     * @param messages - Initial messages for subagent
     * @returns Promise resolving to subagent response
     */
    executeIsolated(messages: Message[]): Promise<string>;
}

/**
 * Agent lifecycle event types
 * Used for monitoring and debugging agent behavior
 */
export type AgentLifecycleEvent =
    | { type: "start"; timestamp: number }
    | { type: "tool_use"; toolName: string; timestamp: number }
    | { type: "tool_result"; toolName: string; success: boolean; timestamp: number }
    | { type: "complete"; timestamp: number }
    | { type: "error"; error: string; timestamp: number };

/**
 * Agent state
 * Represents the current state of an agent
 */
export interface AgentState {
    /** Current message history */
    messages: Message[];
    /** Whether the agent is currently running */
    isRunning: boolean;
    /** Lifecycle event log */
    eventLog: AgentLifecycleEvent[];
}

/**
 * Agent factory type
 * Function that creates agent instances
 * In Python: Would be a class or factory function
 */
export type AgentFactory = (config: AgentConfig) => Agent;
