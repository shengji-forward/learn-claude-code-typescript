# Session 5: Skill Loading

## Overview

This session adds dynamic skill loading from YAML files. Agents can now load specialized knowledge and behaviors on-demand, making them more flexible and powerful.

### What You'll Learn

- **YAML Parsing**: Parse frontmatter and skill files
- **Dynamic Loading**: Load skills at runtime
- **Skill Injection**: Add skills to system prompt
- **Error Handling**: Handle missing or invalid skills
- **Type Safety**: Validate skill structure

## Running the Session

```bash
npm run s05
# or
ts-node agents/s05_skill_loading.ts
```

## Key Implementation Details

### TypeScript vs Python

**YAML Parsing**:
- **Python**: `yaml.safe_load()` with python dicts
- **TypeScript**: `js-yaml` library with type assertions
- **Why**: JavaScript doesn't have built-in YAML support

**Skill Storage**:
- **Python**: Skills/ directory with .py files
- **TypeScript**: Skills/ directory with .md files
- **Why**: Markdown is more readable for documentation

**Frontmatter Parsing**:
- **Python**: Custom frontmatter parser
- **TypeScript**: Regex-based frontmatter extraction
- **Why**: Extract YAML from markdown files

## Code Examples

### Skill File Structure

```markdown
<!-- skills/coding.md -->
---
name: coding
description: Expert programming knowledge
instructions: |
  You are an expert programmer with deep knowledge of
  software architecture, best practices, and patterns.
  Always write clean, maintainable code.
---

# Coding Skill

This skill provides expert programming knowledge.
```

### Skill Interface

```typescript
interface Skill {
    name: string;
    description: string;
    instructions: string;
    content?: string;
}
```

### Skill Loader Class

```typescript
import * as yaml from "js-yaml";
import { promises as fs } from "fs";
import * as path from "path";

class SkillLoader {
    private skillsDir: string;
    private cache: Map<string, Skill> = new Map();

    constructor(skillsDir: string) {
        this.skillsDir = skillsDir;
    }

    async load(skillName: string): Promise<Skill> {
        // Check cache first
        if (this.cache.has(skillName)) {
            return this.cache.get(skillName)!;
        }

        const skillPath = path.join(this.skillsDir, `${skillName}.md`);

        try {
            const content = await fs.readFile(skillPath, "utf-8");
            const skill = this.parseSkill(content);
            this.cache.set(skillName, skill);
            return skill;
        } catch (error) {
            throw new Error(`Failed to load skill '${skillName}': ${error}`);
        }
    }

    private parseSkill(content: string): Skill {
        // Extract frontmatter
        const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
        if (!frontmatterMatch) {
            throw new Error("Invalid skill format: missing frontmatter");
        }

        // Parse YAML frontmatter
        const frontmatter = yaml.load(frontmatterMatch[1]) as Skill;

        // Validate required fields
        if (!frontmatter.name || !frontmatter.description || !frontmatter.instructions) {
            throw new Error("Invalid skill: missing required fields");
        }

        // Extract markdown content (everything after frontmatter)
        const markdownContent = content.substring(frontmatterMatch[0].length);

        return {
            ...frontmatter,
            content: markdownContent.trim(),
        };
    }
}
```

### Load Skill Tool Handler

```typescript
const SKILLS = new SkillLoader("skills");

const loadSkillHandler: ToolHandler = async (input: unknown) => {
    const { name } = input as { name: string };

    try {
        const skill = await SKILLS.load(name);

        console.log(`\n📚 Loaded skill: ${skill.name}`);
        console.log(`   ${skill.description}\n`);

        // Return skill instructions for injection into system prompt
        return skill.instructions;
    } catch (error) {
        return `Error loading skill: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
};
```

### Skill Injection in System Prompt

```typescript
const SYSTEM = `You are a coding agent. Use load_skill to gain specialized knowledge.

Available skills: coding, debugging, testing, architecture

Example:
load_skill: { "name": "coding" }`;

// After loading skill, inject instructions into conversation
async function injectSkill(skillInstructions: string): Promise<void> {
    messages.push({
        role: "user",
        content: `<skill>\n${skillInstructions}\n</skill>`
    });
}
```

## Architecture

```
┌─────────────────────────────────────────┐
│           Skill Loader                  │
├─────────────────────────────────────────┤
│  1. Read skill file from disk           │
│  2. Extract YAML frontmatter            │
│  3. Parse YAML metadata                 │
│  4. Validate skill structure            │
│  5. Cache skill for reuse               │
│  6. Return skill instructions           │
└─────────────────────────────────────────┘
```

## TypeScript-Specific Features

### Type Assertions with YAML

```typescript
const frontmatter = yaml.load(yamlString) as Skill;

// Instead of 'any', use specific type
if (typeof frontmatter.name !== "string") {
    throw new Error("Invalid skill name");
}
```

### Generic Cache Class

```typescript
class Cache<T> {
    private store: Map<string, T> = new Map();

    get(key: string): T | undefined {
        return this.store.get(key);
    }

    set(key: string, value: T): void {
        this.store.set(key, value);
    }

    has(key: string): boolean {
        return this.store.has(key);
    }
}

// Usage
const skillCache = new Cache<Skill>();
```

### Error Type Guards

```typescript
function isFileError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

try {
    await fs.readFile(skillPath, "utf-8");
} catch (error) {
    if (isFileError(error) && error.code === "ENOENT") {
        throw new Error(`Skill not found: ${skillName}`);
    }
    throw error;
}
```

## Best Practices

1. **Validate skill structure** before using
2. **Cache loaded skills** for performance
3. **Handle missing skills** gracefully
4. **Sanitize skill instructions** before injection
5. **Use skill descriptions** for discoverability
6. **Document skill parameters** clearly
7. **Version skills** for compatibility

## Troubleshooting

**Issue**: "Invalid skill format" error
- **Solution**: Ensure YAML frontmatter is properly formatted

**Issue**: Skill not found
- **Solution**: Check skill file name matches requested name

**Issue**: Type errors on parsed YAML
- **Solution**: Use type assertions and validation

## Summary

Skill loading enables agents to gain specialized knowledge dynamically. YAML frontmatter provides structured skill metadata. TypeScript's type system ensures skill validity at runtime.

**Key Takeaways**:
- YAML frontmatter for skill metadata
- js-yaml library for parsing
- Caching improves performance
- Type validation prevents errors
- Skills extend agent capabilities
