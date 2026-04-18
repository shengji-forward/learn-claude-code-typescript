# s05: Skills

`s01 > s02 > s03 > s04 > [ s05 ] s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"Load knowledge when you need it, not upfront"* -- inject via `tool_result`, not the system prompt.
>
> **Harness layer**: On-demand knowledge -- domain expertise, loaded when the model asks.

## Problem

You want the agent to follow domain-specific workflows: git conventions, testing patterns, code review checklists. Putting everything in the system prompt wastes tokens on unused skills. Many skills are irrelevant to any given task.

## Solution

```
System prompt (Layer 1 -- always present):
+--------------------------------------+
| You are a coding agent.              |
| Skills available:                    |
|   - git: Git workflow helpers        |  ~100 tokens/skill
|   - test: Testing best practices     |
+--------------------------------------+

When model calls load_skill("git"):
+--------------------------------------+
| tool_result (Layer 2 -- on demand):  |
| <skill name="git">                   |
|   Full git workflow instructions...  |
| </skill>                             |
+--------------------------------------+
```

Layer 1: skill *names* in system prompt (cheap). Layer 2: full *body* via `tool_result` (on demand).

## How It Works

1. Each skill is a directory containing a `SKILL.md` with YAML frontmatter under `skills/`.

2. SkillLoader scans for `SKILL.md` files and caches metadata + body.

```typescript
class SkillLoader {
  private skills = new Map<string, SkillRecord>();

  async init(): Promise<void> {
    // walk skills/**/SKILL.md and cache metadata + body
  }

  getDescriptions(): string {
    // short lines for the system prompt
  }

  getContent(name: string): string {
    return `<skill name="${name}">\n${body}\n</skill>`;
  }
}
```

3. Layer 1 goes into the system prompt. Layer 2 is another tool handler.

```typescript
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

// load_skill handler returns SKILL_LOADER.getContent(name)
```

## What Changed From s04

| Component      | Before (s04)     | After (s05)                |
|----------------|------------------|----------------------------|
| Tools          | 5 (base + task) | 5 (base + load_skill)      |
| System prompt  | Static string    | + skill descriptions       |
| Knowledge      | None             | `skills/*/SKILL.md` files  |
| Injection      | None             | Two-layer (system + result)|

## Try It

```sh
npm run s05
```

1. `What skills are available?`
2. `Load a skill and follow its instructions for a small task`
3. `I need a code review -- load the relevant skill first`
