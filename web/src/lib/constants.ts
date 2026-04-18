export const VERSION_ORDER = [
  "s01",
  "s02",
  "s03",
  "s04",
  "s05",
  "s06",
  "s07",
  "s08",
  "s09",
  "s10",
  "s11",
  "s12",
] as const;

export const LEARNING_PATH = VERSION_ORDER;

export type VersionId = typeof LEARNING_PATH[number];
export type LearningLayer = "loop" | "planning" | "persistence" | "teams";

export const VERSION_META: Record<string, {
  title: string;
  subtitle: string;
  coreAddition: string;
  keyInsight: string;
  layer: LearningLayer;
  prevVersion: string | null;
}> = {
  s01: {
    title: "The Agent Loop",
    subtitle: "Minimal Closed Loop",
    coreAddition: "LoopState + tool_result feedback",
    keyInsight: "An agent is just a loop: send messages, execute tools, feed results back, repeat.",
    layer: "loop",
    prevVersion: null,
  },
  s02: {
    title: "Tool Use",
    subtitle: "Route Intent into Action",
    coreAddition: "Tool specs + dispatch map",
    keyInsight: "Adding a tool means adding one handler. The loop never changes.",
    layer: "loop",
    prevVersion: "s01",
  },
  s03: {
    title: "TodoWrite",
    subtitle: "Session Planning",
    coreAddition: "PlanningState + reminder loop",
    keyInsight: "A visible plan keeps the agent on track when tasks get complex.",
    layer: "planning",
    prevVersion: "s02",
  },
  s04: {
    title: "Subagent",
    subtitle: "Fresh Context per Subtask",
    coreAddition: "Delegation with isolated message history",
    keyInsight: "A subagent is mainly a context boundary, not a process trick.",
    layer: "planning",
    prevVersion: "s03",
  },
  s05: {
    title: "Skills",
    subtitle: "Discover Cheap, Load Deep",
    coreAddition: "Skill registry + on-demand injection",
    keyInsight: "Discover cheaply, load deeply -- only when needed.",
    layer: "planning",
    prevVersion: "s04",
  },
  s06: {
    title: "Context Compact",
    subtitle: "Keep the Active Context Small",
    coreAddition: "Persist markers + micro compact + summary compact",
    keyInsight: "Compaction isn't deleting history -- it's relocating detail so the agent can keep working.",
    layer: "planning",
    prevVersion: "s05",
  },
  s07: {
    title: "Task System",
    subtitle: "Durable Work Graph",
    coreAddition: "Task records + dependencies + unlock rules",
    keyInsight: "Todo lists help a session; durable task graphs coordinate work that outlives it.",
    layer: "persistence",
    prevVersion: "s06",
  },
  s08: {
    title: "Background Tasks",
    subtitle: "Separate Goal from Running Work",
    coreAddition: "RuntimeTaskState + async execution slots",
    keyInsight: "Background execution is a runtime lane, not a second main loop.",
    layer: "persistence",
    prevVersion: "s07",
  },
  s09: {
    title: "Agent Teams",
    subtitle: "Persistent Specialists",
    coreAddition: "Team roster + teammate lifecycle",
    keyInsight: "Teammates persist beyond one prompt, have identity, and coordinate through durable channels.",
    layer: "teams",
    prevVersion: "s08",
  },
  s10: {
    title: "Team Protocols",
    subtitle: "Shared Request-Response Rules",
    coreAddition: "Protocol envelopes + request correlation",
    keyInsight: "A protocol request is a structured message with an ID; the response must reference the same ID.",
    layer: "teams",
    prevVersion: "s09",
  },
  s11: {
    title: "Autonomous Agents",
    subtitle: "Self-Claim and Self-Resume",
    coreAddition: "Idle polling + role-aware self-claim + resume context",
    keyInsight: "Autonomy is a bounded mechanism -- idle, scan, claim, resume -- not magic.",
    layer: "teams",
    prevVersion: "s10",
  },
  s12: {
    title: "Worktree + Task Isolation",
    subtitle: "Separate Directory, Separate Lane",
    coreAddition: "Task-worktree state + explicit enter/closeout lifecycle",
    keyInsight: "Tasks answer what; worktrees answer where. Keep them separate.",
    layer: "teams",
    prevVersion: "s11",
  },
};

export const LAYERS = [
  {
    id: "loop" as const,
    label: "The Loop",
    color: "#2563EB",
    versions: ["s01", "s02"],
  },
  {
    id: "planning" as const,
    label: "Planning & Knowledge",
    color: "#059669",
    versions: ["s03", "s04", "s05", "s06"],
  },
  {
    id: "persistence" as const,
    label: "Persistence",
    color: "#D97706",
    versions: ["s07", "s08"],
  },
  {
    id: "teams" as const,
    label: "Teams",
    color: "#DC2626",
    versions: ["s09", "s10", "s11", "s12"],
  },
] as const;
