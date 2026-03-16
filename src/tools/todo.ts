/**
 * Todo Tool Handler
 *
 * Manages todo items for tracking agent progress.
 *
 * Python vs TypeScript:
 * - Python: TodoManager class with instance variables
 * - TypeScript: Class with proper property types and interfaces
 * - Strict validation with TypeScript compiler + runtime checks
 * - Enum for todo status values
 */

/**
 * Todo item status
 * In Python: String literals "pending", "in_progress", "completed"
 */
export enum TodoStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
}

/**
 * Todo item interface
 * In Python: Dict with id, text, status keys
 */
export interface TodoItem {
    /** Unique identifier for the todo item */
    id: string;
    /** Todo item description */
    text: string;
    /** Current status of the todo item */
    status: TodoStatus;
}

/**
 * Input format for todo items (from API)
 * In Python: Dict from JSON with string values
 */
export interface TodoItemInput {
    id?: string;
    text: string;
    status?: string;
}

/**
 * TodoManager class
 *
 * Manages todo items with validation and rendering.
 * Provides structured state for the agent to track progress.
 *
 * Python equivalent:
 * ```python
 * class TodoManager:
 *     def __init__(self):
 *         self.items = []
 *
 *     def update(self, items: list) -> str:
 *         # validation logic
 *         return self.render()
 *
 *     def render(self) -> str:
 *         # render todos with markers
 * ```
 */
export class TodoManager {
    private items: TodoItem[] = [];

    /**
     * Update todo items with validation
     *
     * @param itemsInput - Array of todo items from API
     * @returns Rendered todo list
     * @throws Error if validation fails
     *
     * Python equivalent:
     * ```python
     * def update(self, items: list) -> str:
     *     if len(items) > 20:
     *         raise ValueError("Max 20 todos allowed")
     *     # ... validation logic
     * ```
     */
    update(itemsInput: TodoItemInput[]): string {
        // Validate max items
        if (itemsInput.length > 20) {
            throw new Error("Max 20 todos allowed");
        }

        const validated: TodoItem[] = [];
        let inProgressCount = 0;

        // Validate each item
        for (let i = 0; i < itemsInput.length; i++) {
            const item = itemsInput[i];
            const text = String(item.text || "").trim();
            const statusStr = String(item.status || "pending").toLowerCase();
            const itemId = String(item.id || String(i + 1));

            // Validate text
            if (!text) {
                throw new Error(`Item ${itemId}: text required`);
            }

            // Validate status
            if (
                ![
                    TodoStatus.PENDING,
                    TodoStatus.IN_PROGRESS,
                    TodoStatus.COMPLETED,
                ].includes(statusStr as TodoStatus)
            ) {
                throw new Error(
                    `Item ${itemId}: invalid status '${statusStr}'`
                );
            }

            const status = statusStr as TodoStatus;

            // Count in_progress items
            if (status === TodoStatus.IN_PROGRESS) {
                inProgressCount++;
            }

            validated.push({
                id: itemId,
                text,
                status,
            });
        }

        // Validate only one in_progress
        if (inProgressCount > 1) {
            throw new Error("Only one task can be in_progress at a time");
        }

        // Update internal state
        this.items = validated;

        // Return rendered output
        return this.render();
    }

    /**
     * Render todo items as formatted string
     *
     * @returns Formatted todo list
     *
     * Python equivalent:
     * ```python
     * def render(self) -> str:
     *     if not self.items:
     *         return "No todos."
     *     lines = []
     *     for item in self.items:
     *         marker = {"pending": "[ ]", "in_progress": "[>]", "completed": "[x]"}[item["status"]]
     *         lines.append(f"{marker} #{item['id']}: {item['text']}")
     *     done = sum(1 for t in self.items if t["status"] == "completed")
     *     lines.append(f"\n({done}/{len(self.items)} completed)")
     *     return "\n".join(lines)
     * ```
     */
    render(): string {
        if (this.items.length === 0) {
            return "No todos.";
        }

        const lines: string[] = [];

        // Map status to marker
        const markers: Record<TodoStatus, string> = {
            [TodoStatus.PENDING]: "[ ]",
            [TodoStatus.IN_PROGRESS]: "[>]",
            [TodoStatus.COMPLETED]: "[x]",
        };

        // Render each item
        for (const item of this.items) {
            const marker = markers[item.status];
            lines.push(`${marker} #${item.id}: ${item.text}`);
        }

        // Add completion summary
        const completed = this.items.filter(
            (t) => t.status === TodoStatus.COMPLETED
        ).length;
        lines.push(`\n(${completed}/${this.items.length} completed)`);

        return lines.join("\n");
    }

    /**
     * Get current todo items
     * @returns Copy of internal items array
     */
    getItems(): TodoItem[] {
        return [...this.items];
    }

    /**
     * Clear all todo items
     */
    clear(): void {
        this.items = [];
    }
}

/**
 * Create todo tool handler bound to a TodoManager instance
 *
 * @param manager - TodoManager instance
 * @returns Tool handler function
 *
 * Python equivalent:
 * ```python
 * def run_todo(**kw) -> str:
 *     return TODO.update(kw["items"])
 * ```
 */
export function createTodoHandler(manager: TodoManager) {
    return async (input: Record<string, unknown>): Promise<string> => {
        const items = input.items as TodoItemInput[];
        return manager.update(items);
    };
}

/**
 * Create todo tool definition for the agent
 *
 * @returns Tool object compatible with Anthropic API
 *
 * Python equivalent:
 * ```python
 * {"name": "todo", "description": "Update todo list.",
 *  "input_schema": {
 *      "type": "object",
 *      "properties": {
 *          "items": {"type": "array", "items": {...}},
 *      },
 *      "required": ["items"],
 *  }}
 * ```
 */
export function createTodoTool() {
    return {
        name: "todo",
        description: "Update todo list. Use to plan and track progress on multi-step tasks.",
        input_schema: {
            type: "object" as const,
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            text: { type: "string" },
                            status: {
                                type: "string",
                                enum: [
                                    TodoStatus.PENDING,
                                    TodoStatus.IN_PROGRESS,
                                    TodoStatus.COMPLETED,
                                ],
                            },
                        },
                        required: ["text"],
                    },
                },
            },
            required: ["items"] as const,
        },
    };
}
