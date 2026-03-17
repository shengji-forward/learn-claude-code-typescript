import * as fs from "fs";
import * as path from "path";
import type {
  AgentVersion,
  VersionDiff,
  DocContent,
  VersionIndex,
} from "../src/types/agent-data";
import { VERSION_META, VERSION_ORDER, LEARNING_PATH } from "../src/lib/constants";

const WEB_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_DIR, "..");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");
const DOCS_EN_DIR = path.join(REPO_ROOT, "docs", "en");
const OUT_DIR = path.join(WEB_DIR, "src", "data", "generated");

function filenameToVersionId(filename: string): string | null {
  const base = path.basename(filename, ".ts");
  if (
    base === "s_full" ||
    base === "__init__" ||
    base === "task-worker" ||
    base === "teammate-worker" ||
    base === "autonomous-worker"
  ) {
    return null;
  }

  const match = base.match(/^(s\d+[a-c]?)_/);
  return match ? match[1] : null;
}

function extractClasses(lines: string[]): { name: string; startLine: number; endLine: number }[] {
  const classes: { name: string; startLine: number; endLine: number }[] = [];
  const classPattern = /^\s*class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(classPattern);
    if (!m) continue;

    const name = m[1];
    const startLine = i + 1;
    let endLine = lines.length;

    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].match(/^\s*class\s+\w+/) || lines[j].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/)) {
        endLine = j;
        break;
      }
    }

    classes.push({ name, startLine, endLine });
  }

  return classes;
}

function extractFunctions(lines: string[]): { name: string; signature: string; startLine: number }[] {
  const functions: { name: string; signature: string; startLine: number }[] = [];
  const fnPattern = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnPattern);
    if (!m) continue;

    functions.push({
      name: m[1],
      signature: lines[i].trim(),
      startLine: i + 1,
    });
  }

  return functions;
}

function extractTools(source: string): string[] {
  const toolPattern = /name:\s*"([A-Za-z0-9_]+)"\s*,\s*description:\s*"[\s\S]*?"\s*,\s*input_schema:/g;
  const tools = new Set<string>();
  let match: RegExpExecArray | null = null;

  while ((match = toolPattern.exec(source)) !== null) {
    tools.add(match[1]);
  }

  return Array.from(tools);
}

function countLoc(lines: string[]): number {
  let inBlockComment = false;

  return lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;

    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      return false;
    }

    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      return false;
    }

    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      return false;
    }

    return true;
  }).length;
}

function extractDocVersion(filename: string): string | null {
  const m = filename.match(/^(s\d+[a-c]?)-/);
  return m ? m[1] : null;
}

function main() {
  console.log("Extracting content from TypeScript agents and docs/en...");
  console.log(`  Repo root: ${REPO_ROOT}`);
  console.log(`  Agents dir: ${AGENTS_DIR}`);
  console.log(`  Docs dir: ${DOCS_EN_DIR}`);

  if (!fs.existsSync(AGENTS_DIR)) {
    console.log("  Agents directory not found, skipping extraction.");
    console.log("  Using pre-committed generated data.");
    return;
  }

  const agentFiles = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.startsWith("s") && f.endsWith(".ts"));

  console.log(`  Found ${agentFiles.length} TypeScript agent files`);

  const versions: AgentVersion[] = [];

  for (const filename of agentFiles) {
    const versionId = filenameToVersionId(filename);
    if (!versionId) {
      continue;
    }

    const filePath = path.join(AGENTS_DIR, filename);
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");

    const meta = VERSION_META[versionId];
    const classes = extractClasses(lines);
    const functions = extractFunctions(lines);
    const tools = extractTools(source);
    const loc = countLoc(lines);

    versions.push({
      id: versionId,
      filename,
      title: meta?.title ?? versionId,
      subtitle: meta?.subtitle ?? "",
      loc,
      tools,
      newTools: [],
      coreAddition: meta?.coreAddition ?? "",
      keyInsight: meta?.keyInsight ?? "",
      classes,
      functions,
      layer: meta?.layer ?? "tools",
      source,
    });
  }

  const orderMap = new Map(VERSION_ORDER.map((v, i) => [v, i]));
  versions.sort((a, b) => (orderMap.get(a.id as any) ?? 99) - (orderMap.get(b.id as any) ?? 99));

  for (let i = 0; i < versions.length; i++) {
    const prev = i > 0 ? new Set(versions[i - 1].tools) : new Set<string>();
    versions[i].newTools = versions[i].tools.filter((t) => !prev.has(t));
  }

  const diffs: VersionDiff[] = [];
  const versionMap = new Map(versions.map((v) => [v.id, v]));

  for (let i = 1; i < LEARNING_PATH.length; i++) {
    const fromId = LEARNING_PATH[i - 1];
    const toId = LEARNING_PATH[i];
    const fromVer = versionMap.get(fromId);
    const toVer = versionMap.get(toId);

    if (!fromVer || !toVer) continue;

    const fromClassNames = new Set(fromVer.classes.map((c) => c.name));
    const fromFuncNames = new Set(fromVer.functions.map((f) => f.name));
    const fromToolNames = new Set(fromVer.tools);

    diffs.push({
      from: fromId,
      to: toId,
      newClasses: toVer.classes.map((c) => c.name).filter((n) => !fromClassNames.has(n)),
      newFunctions: toVer.functions.map((f) => f.name).filter((n) => !fromFuncNames.has(n)),
      newTools: toVer.tools.filter((t) => !fromToolNames.has(t)),
      locDelta: toVer.loc - fromVer.loc,
    });
  }

  const docs: DocContent[] = [];

  if (fs.existsSync(DOCS_EN_DIR)) {
    const docFiles = fs
      .readdirSync(DOCS_EN_DIR)
      .filter((f) => f.endsWith(".md"));

    for (const filename of docFiles) {
      const version = extractDocVersion(filename);
      if (!version) {
        console.warn(`  Skipping doc ${filename}: could not determine version`);
        continue;
      }

      const filePath = path.join(DOCS_EN_DIR, filename);
      const content = fs.readFileSync(filePath, "utf-8");

      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : filename;

      docs.push({ version, locale: "en", title, content });
    }

    console.log(`  Found ${docFiles.length} docs in docs/en`);
  } else {
    console.warn(`  Docs directory not found: ${DOCS_EN_DIR}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index: VersionIndex = { versions, diffs };
  const indexPath = path.join(OUT_DIR, "versions.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`  Wrote ${indexPath}`);

  const docsPath = path.join(OUT_DIR, "docs.json");
  fs.writeFileSync(docsPath, JSON.stringify(docs, null, 2));
  console.log(`  Wrote ${docsPath}`);

  console.log("\nExtraction complete:");
  console.log(`  ${versions.length} versions`);
  console.log(`  ${diffs.length} diffs`);
  console.log(`  ${docs.length} docs`);
  for (const v of versions) {
    console.log(
      `    ${v.id}: ${v.loc} LOC, ${v.tools.length} tools, ${v.classes.length} classes, ${v.functions.length} functions`
    );
  }
}

main();
