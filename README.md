> **Note**  
> This repository is a TypeScript edition derived from the original Python project: [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code).

# Learn Claude Code (TypeScript Edition)

A session-by-session TypeScript walkthrough for building a nano Claude Code-like coding agent from scratch.

```
                THE AGENT LOOP
                ==============

User -> messages[] -> LLM -> response
                         |
               stop_reason == "tool_use"?
                     /              \
                   yes               no
                    |                |
             execute tools       return text
             append results
             loop back -> messages[]
```

This loop is the kernel. Every later session adds one mechanism around that kernel.

## What You Build

- `s01-s02`: Core loop and tool dispatch
- `s03-s06`: Planning, skill loading, and context durability
- `s07-s08`: Persistent task graph and background execution
- `s09-s12`: Team coordination, protocols, autonomous behavior, and worktree isolation

## Learning Roadmap

```
Phase 1: THE LOOP                    Phase 2: PLANNING & KNOWLEDGE
==================                   ==============================
s01  The Agent Loop          [1]     s03  TodoWrite               [5]
     while + stop_reason                  TodoManager + nag reminder
     |                                    |
     +-> s02  Tool Use            [4]     s04  Subagents            [5]
              dispatch map: name->handler     fresh messages[] per child
                                              |
                                         s05  Skills               [5]
                                              SKILL.md via tool_result
                                              |
                                         s06  Context Compact      [5]
                                              3-layer compression

Phase 3: PERSISTENCE                 Phase 4: TEAMS
==================                   =====================
s07  Tasks                   [8]     s09  Agent Teams             [9]
     file-based CRUD + deps graph         teammates + JSONL mailboxes
     |                                    |
s08  Background Tasks        [6]     s10  Team Protocols          [12]
     worker threads + notify queue        shutdown + plan approval FSM
                                          |
                                     s11  Autonomous Agents       [14]
                                          idle cycle + auto-claim
                                     |
                                     s12  Worktree Isolation      [16]
                                          task coordination + optional isolated execution lanes

                                     [N] = number of tools
```

## Scope

This repo is a teaching implementation, not a production agent runtime. It intentionally does **not** include:

- Full lifecycle/hook buses
- Full policy and trust governance
- Session resume/fork orchestration
- Complete MCP runtime behavior

Use it to learn architecture and mechanism design in a small, readable codebase.

## Quick Start

```sh
git clone https://github.com/shengji-forward/learn-claude-code-typescript
cd learn-claude-code-typescript
npm install
cp .env.example .env
# set ANTHROPIC_API_KEY and MODEL_ID in .env

npm run s01
```

Run any session directly:

```sh
npm run s02
npm run s03
# ...
npm run s12
npm run s:full
```

## Learning Site

The web app visualizes mechanisms, timelines, docs, and diffs.

```sh
npm --prefix web install
npm --prefix web run dev
# http://localhost:3000/en
```

## Session Map

| Session | Topic | Key Addition |
|---|---|---|
| `s01` | The Agent Loop | Single-tool loop with `stop_reason` gate |
| `s02` | Tool Use | Dispatch map and file-safe tools |
| `s03` | TodoWrite | Explicit task planning with status tracking |
| `s04` | Subagents | Isolated child context for delegated subtasks |
| `s05` | Skills | On-demand knowledge injection from `SKILL.md` |
| `s06` | Context Compact | Three-layer compression for long sessions |
| `s07` | Task System | Disk-backed task graph with dependencies |
| `s08` | Background Tasks | Non-blocking command execution with notifications |
| `s09` | Agent Teams | Persistent teammates with JSONL inboxes |
| `s10` | Team Protocols | `request_id`-based shutdown and plan review |
| `s11` | Autonomous Agents | Idle polling + auto-claim behavior |
| `s12` | Worktree + Task Isolation | Shared control plane + isolated execution lanes |

## Repository Layout

```
learn-claude-code-typescript/
├── agents/                 # TypeScript session implementations (s01-s12 + s_full)
├── docs/en/                # English learning docs for each session
├── web/                    # Next.js learning interface (/en/...)
└── skills/                 # Skill files used in s05
```

## Docs

- [s01 The Agent Loop](./docs/en/s01-the-agent-loop.md)
- [s02 Tool Use](./docs/en/s02-tool-use.md)
- [s03 TodoWrite](./docs/en/s03-todo-write.md)
- [s04 Subagents](./docs/en/s04-subagent.md)
- [s05 Skill Loading](./docs/en/s05-skill-loading.md)
- [s06 Context Compact](./docs/en/s06-context-compact.md)
- [s07 Task System](./docs/en/s07-task-system.md)
- [s08 Background Tasks](./docs/en/s08-background-tasks.md)
- [s09 Agent Teams](./docs/en/s09-agent-teams.md)
- [s10 Team Protocols](./docs/en/s10-team-protocols.md)
- [s11 Autonomous Agents](./docs/en/s11-autonomous-agents.md)
- [s12 Worktree Task Isolation](./docs/en/s12-worktree-task-isolation.md)

## Validation Commands

```sh
npm run type-check
npm run build
npm --prefix web run extract
npm --prefix web run build
```

## License

MIT
