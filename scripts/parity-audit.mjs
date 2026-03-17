#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const REF = path.join(ROOT, "learn-claude-code");

function gitFiles(repoPath) {
    const out = execSync("git ls-files", { cwd: repoPath, encoding: "utf8" });
    return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
}

function walkFiles(dir, base = dir, out = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(base, abs).replaceAll(path.sep, "/");
        if (entry.isDirectory()) {
            if ([".git", "node_modules", "learn-claude-code", ".claude", "dist"].includes(entry.name)) {
                continue;
            }
            walkFiles(abs, base, out);
            continue;
        }
        out.push(rel);
    }
    return out;
}

function toTsExpectation(pyFile) {
    if (pyFile.startsWith("agents/") && pyFile.endsWith(".py")) {
        return pyFile.replace(/\.py$/, ".ts");
    }
    return pyFile;
}

function extractContracts(filePath, lang) {
    const src = fs.readFileSync(filePath, "utf8");
    const lines = src.split("\n");
    const names = new Set();

    const pyNameRe = /^\s*(?:\{"name"|"name")\s*:\s*"([^"]+)"/;
    const tsNameRe = /^\s*\{?\s*name:\s*"([^"]+)"/;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const m = (lang === "py" ? pyNameRe : tsNameRe).exec(line);
        if (!m) {
            continue;
        }

        if (/^[A-Za-z0-9_]+$/.test(m[1])) {
            names.add(m[1]);
        }
    }

    return names;
}

function headings(readmePath) {
    return fs
        .readFileSync(readmePath, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.replace(/^##\s+/, "").trim());
}

const pyFiles = gitFiles(REF);
const tsFiles = walkFiles(ROOT).sort();
const tsSet = new Set(tsFiles);

const expectedTs = new Set();
for (const pyFile of pyFiles) {
    if (pyFile === "requirements.txt") {
        expectedTs.add("package.json");
        expectedTs.add("tsconfig.json");
        continue;
    }
    expectedTs.add(toTsExpectation(pyFile));
}

const allowedTsOnly = new Set([
    "scripts/parity-audit.mjs",
    "agents/task-worker.ts",
    "agents/teammate-worker.ts",
    "agents/autonomous-worker.ts",
    "package-lock.json",
    "CONTINUATION_PLAN.md",
    "FEATURE_MATRIX.md",
    "GITHUB_SETUP_INSTRUCTIONS.md",
    "HANDOFF_INDEX.md",
    "IMPLEMENTATION_SUMMARY.md",
    "QUICKSTART_NEXT_SESSION.md",
    "TASKS_REMAINING.md",
    "VERIFICATION.md",
]);

const missing = [];
for (const needed of expectedTs) {
    if (!tsSet.has(needed)) {
        missing.push(needed);
    }
}

const extra = [];
for (const tsFile of tsFiles) {
    if (!expectedTs.has(tsFile) && !allowedTsOnly.has(tsFile)) {
        extra.push(tsFile);
    }
}

const contractIssues = [];
const pyAgentFiles = pyFiles.filter((f) => f.startsWith("agents/s") && f.endsWith(".py"));
for (const pyAgent of pyAgentFiles) {
    const tsAgent = pyAgent.replace(/\.py$/, ".ts");
    const pyPath = path.join(REF, pyAgent);
    const tsPath = path.join(ROOT, tsAgent);
    if (!fs.existsSync(tsPath)) {
        contractIssues.push(`${pyAgent}: missing ${tsAgent}`);
        continue;
    }

    const pyTools = extractContracts(pyPath, "py");
    const tsTools = extractContracts(tsPath, "ts");

    for (const toolName of pyTools.values()) {
        if (!tsTools.has(toolName)) {
            contractIssues.push(`${tsAgent}: missing tool '${toolName}'`);
        }
    }
}

const pyReadmeHeadings = headings(path.join(REF, "README.md"));
const tsReadmeHeadings = new Set(headings(path.join(ROOT, "README.md")));
const headingMissing = pyReadmeHeadings.filter((h) => !tsReadmeHeadings.has(h));

let failed = false;
if (missing.length > 0) {
    failed = true;
    console.error("Missing files:");
    for (const f of missing) {
        console.error(`  - ${f}`);
    }
}

if (extra.length > 0) {
    failed = true;
    console.error("Unexpected extra files:");
    for (const f of extra) {
        console.error(`  - ${f}`);
    }
}

if (contractIssues.length > 0) {
    failed = true;
    console.error("Tool contract issues:");
    for (const issue of contractIssues) {
        console.error(`  - ${issue}`);
    }
}

if (headingMissing.length > 0) {
    failed = true;
    console.error("README section parity issues:");
    for (const h of headingMissing) {
        console.error(`  - missing heading: ${h}`);
    }
}

if (failed) {
    process.exit(1);
}

console.log("Parity audit passed: file set, tool contracts, and README sections are aligned.");
