# Learn Claude Code - TypeScript Edition

> **Note**: This is the TypeScript edition of [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code), the original Python implementation. If you prefer to learn with Python, please visit the original repository.

```
                    THE AGENT PATTERN
                    =================

    User --> messages[] --> LLM --> response
                                      |
                            stop_reason == "tool_use"?
                           /                          \
                         yes                           no
                          |                             |
                    execute tools                    return text
                    append results
                    loop back -----------------> messages[]


    That's the minimal loop. Every AI coding agent needs this loop.
    Production agents add policy, permissions, and lifecycle layers.
```

**12 progressive sessions, from a simple loop to isolated autonomous execution.**
**Each session adds one mechanism. Each mechanism has one motto.**

> **s01** &nbsp; *"One loop & Bash is all you need"* &mdash; one tool + one loop = an agent
>
> **s02** &nbsp; *"Adding a tool means adding one handler"* &mdash; the loop stays the same; new tools register into the dispatch map
>
> **s03** &nbsp; *"An agent without a plan drifts"* &mdash; list the steps first, then execute; completion doubles
>
> **s04** &nbsp; *"Break big tasks down; each subtask gets a clean context"* &mdash; subagents use independent messages[], keeping the main conversation clean
>
> **s05** &nbsp; *"Load knowledge when you need it, not upfront"* &mdash; inject via tool_result, not the system prompt
>
> **s06** &nbsp; *"Context will fill up; you need a way to make room"* &mdash; three-layer compression strategy for infinite sessions
>
> **s07** &nbsp; *"Break big goals into small tasks, order them, persist to disk"* &mdash; a file-based task graph with dependencies, laying the foundation for multi-agent collaboration
>
> **s08** &nbsp; *"Run slow operations in the background; the agent keeps thinking"* &mdash; worker threads run commands, inject notifications on completion
>
> **s09** &nbsp; *"When the task is too big for one, delegate to teammates"* &mdash; persistent teammates + async mailboxes
>
> **s10** &nbsp; *"Teammates need shared communication rules"* &mdash; one request-response pattern drives all negotiation
>
> **s11** &nbsp; *"Teammates scan the board and claim tasks themselves"* &mdash; no need for the lead to assign each one
>
> **s12** &nbsp; *"Each works in its own directory, no interference"* &mdash; tasks manage goals, worktrees manage directories, bound by ID

---

## The Core Pattern

```typescript
async function agentLoop(messages: Message[]): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
        });

        messages.push({
            role: "assistant",
            content: response.content,
        });

        if (response.stop_reason !== "tool_use") {
            return;
        }

        const results: ToolResult[] = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const output = await TOOL_HANDLERS[block.name](block.input);
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
        }
        messages.push({ role: "user", content: results });
    }
}
```

Every session layers one mechanism on top of this loop -- without changing the loop itself.

## TypeScript vs Python

This TypeScript edition maintains **95% feature parity** with the Python version while leveraging TypeScript's type system for enhanced safety and developer experience. All 12 core sessions and the capstone project are fully implemented with identical functionality.

### What's Included (✅ Complete)

**All Core Mechanisms:**
- ✅ All 12 sessions (s01-s12) fully implemented
- ✅ s_full.ts capstone with all features integrated
- ✅ All 4 skills (pdf, code-review, agent-builder, mcp-builder)
- ✅ Complete agent infrastructure (tool dispatch, todos, subagents, skill loading, context compression, tasks, background workers, teams, protocols, autonomous agents, worktrees)

### What's Different (Not Missing)

The TypeScript edition includes several **enhancements** not found in the Python version:

- **Type Safety**: Compile-time error detection vs runtime checks
- **Integration Tests**: Comprehensive test suite for advanced sessions (Python has no tests)
- **Enhanced Documentation**: Individual session guides with TypeScript patterns
- **Better Modularity**: Reusable components across sessions (tools, types, utils)
- **Modern Patterns**: Async/await, discriminated unions, interfaces, ES modules

### What's Python-Only (❌ Not Included)

- **Web Interface**: The Python edition includes a Next.js web interface for interactive visual learning. The TypeScript edition focuses on the CLI learning path, which provides a complete and functional experience.

**Rationale**: The CLI-focused approach is ideal for developers who prefer terminal-based workflows and want to understand agent internals through code inspection and direct execution.

### Key Differences You'll Notice

- **Type Safety**: All messages, tools, and data structures are strongly typed
- **Async/Await**: Uses JavaScript's async patterns instead of Python's asyncio
- **Union Types**: Discriminated unions for content blocks and tool results
- **Interfaces**: Clear contracts for agents, tools, and managers
- **ES Modules**: Modern module system with imports/exports

Each session includes educational comments explaining TypeScript-specific patterns and how they compare to the Python implementation.

## Scope (Important)

This repository is a 0->1 learning project for building a nano Claude Code-like agent.
It intentionally simplifies or omits several production mechanisms:

- Full event/hook buses (for example PreToolUse, SessionStart/End, ConfigChange).
  s12 includes only a minimal append-only lifecycle event stream for teaching.
- Rule-based permission governance and trust workflows
- Session lifecycle controls (resume/fork) and advanced worktree lifecycle controls
- Full MCP runtime details (transport/OAuth/resource subscribe/polling)

Treat the team JSONL mailbox protocol in this repo as a teaching implementation, not a claim about any specific production internals.

## Quick Start

```sh
git clone https://github.com/shengji-forward/learn-claude-code-typescript
cd learn-claude-code-typescript
npm install
cp .env.example .env   # Edit .env with your ANTHROPIC_API_KEY
```

Run a session:

```sh
npm run s01    # Session 1: The Agent Loop
npm run s02    # Session 2: Tool Use
# ... etc
npm run s:full # Complete implementation
```

## Requirements

- **Node.js**: >= 18.0.0
- **npm**: (comes with Node.js)
- **API Key**: Get yours at https://console.anthropic.com/

## Project Structure

```
learn-claude-code-typescript/
├── agents/              # Progressive session implementations (s01-s12, s_full)
│   ├── s01_agent_loop.ts
│   ├── s02_tool_use.ts
│   └── ...
├── src/                 # Shared infrastructure
│   ├── types/          # TypeScript type definitions
│   ├── tools/          # Tool implementations
│   └── utils/          # Shared utilities
├── workers/            # Worker thread implementations
├── tests/              # Integration tests for advanced sessions
│   └── integration/
├── skills/             # Skill definitions
│   ├── pdf/
│   ├── code-review/
│   ├── agent-builder/
│   └── mcp-builder/
├── docs/               # Session documentation
│   └── en/             # English documentation
├── package.json
├── tsconfig.json
└── README.md
```

## Testing

Integration tests are available for advanced sessions:

```sh
npm test                     # Run all tests
npm run test:s10            # Test session 10 only
npm run test:s11            # Test session 11 only
npm run test:s12            # Test session 12 only
npm run test:watch          # Watch mode
```

**Note**: Tests are currently available for sessions s10, s11, s12, and s_full (capstone). Tests for earlier sessions are planned for future releases.

## Documentation

- **English**: [docs/en/](./docs/en/)

Start with [Session 1: The Agent Loop](./docs/en/s01-the-agent-loop.md) for the complete walkthrough.

Available session guides:
- [s01: The Agent Loop](./docs/en/s01-the-agent-loop.md)
- [s02: Tool Use](./docs/en/s02-tool-use.md)
- [s03: Todo Write](./docs/en/s03-todo-write.md)
- [s04: Subagent](./docs/en/s04-subagent.md)
- [s05: Skill Loading](./docs/en/s05-skill-loading.md)
- [s06: Context Compact](./docs/en/s06-context-compact.md)
- [s07: Task System](./docs/en/s07-task-system.md)
- [s08: Background Tasks](./docs/en/s08-background-tasks.md)
- [s09: Agent Teams](./docs/en/s09-agent-teams.md)
- [s10: Team Protocols](./docs/en/s10-team-protocols.md)
- [s11: Autonomous Agents](./docs/en/s11-autonomous-agents.md)
- [s12: Worktree Task Isolation](./docs/en/s12-worktree-task-isolation.md)
- [s_full: Capstone](./docs/en/s_full_capstone.md)

## License

MIT

## Original Python Version

This is the TypeScript edition of [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code). Both repositories are maintained in parallel and serve different developer communities. Choose the language you're most comfortable with!
