# s05: Skills

`s01 > s02 > s03 > s04 > [ s05 ] s06 | s07 > s08 > s09 > s10 > s11 > s12`

> "Load knowledge when you need it, not upfront".

## Problem

Embedding every domain instruction in the system prompt inflates tokens and wastes context window space. Most tasks only need a small subset of available guidance.

## Solution

Use two layers:

- Layer 1: keep skill names and descriptions in the system prompt.
- Layer 2: load full `SKILL.md` content only when the model calls `load_skill`.

```
System prompt: lightweight catalog
          +
Tool call: load_skill("name")
          +
Tool result: full skill body
```

## How It Works

1. Index `SKILL.md` files from `skills/`.

```typescript
class SkillLoader {
  private skills = new Map<string, SkillRecord>();

  async init(): Promise<void> {
    // walk skills/**/SKILL.md and cache metadata + body
  }
}
```

2. Publish only concise descriptions in the system prompt.

```typescript
const SYSTEM = `You are a coding agent at ${WORKDIR}.\nSkills available:\n${SKILLS.describeAll()}`;
```

3. Serve full skill body through tool result.

```typescript
TOOL_HANDLERS.load_skill = async (input) => SKILLS.loadContent(input.name);
```

## What Changed From s04

| Component | s04 | s05 |
|---|---|---|
| Knowledge model | static prompt only | on-demand skill injection |
| Tooling | `task` delegation | `load_skill` |
| Prompt strategy | monolithic | layered (catalog + payload) |

## Try It

```sh
npm run s05
```

- Ask which skills are available.
- Request a task that should trigger `load_skill`.
- Verify that large skill text enters context only when needed.
