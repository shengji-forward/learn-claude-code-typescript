"use client";

import { motion } from "framer-motion";
import { useTranslations } from "@/lib/i18n";
import { VERSION_META, type VersionId } from "@/lib/constants";
import { LayerBadge } from "@/components/ui/badge";

interface OverviewSection {
  title: string;
  body: string;
}

interface OverviewCopy {
  eyebrow: string;
  summary: string;
  sections: OverviewSection[];
  flowLabel: string;
  flow: string[];
  cautionLabel: string;
  caution: string;
  outcomeLabel: string;
  outcome: string;
}

const SURFACE_CLASSES: Record<string, string> = {
  core: "from-blue-500/10 via-blue-500/5 to-transparent",
  hardening: "from-emerald-500/10 via-emerald-500/5 to-transparent",
  runtime: "from-amber-500/10 via-amber-500/5 to-transparent",
  platform: "from-red-500/10 via-red-500/5 to-transparent",
};

const RING_CLASSES: Record<string, string> = {
  core: "ring-blue-500/20",
  hardening: "ring-emerald-500/20",
  runtime: "ring-amber-500/20",
  platform: "ring-red-500/20",
};

const COPY: Record<string, OverviewCopy> = {
  s07: {
    eyebrow: "Intent must pass a gate before execution",
    summary:
      "The permission chapter should teach a control gate, not scattered safety checks. Model intent becomes executable action only after policy classification.",
    sections: [
      {
        title: "Normalize the request first",
        body: "Convert raw tool calls into a structured intent with action type, target, and risk level before making any permission decision.",
      },
      {
        title: "Keep policy separate",
        body: "Read-only modes, allowlists, dangerous-command blocks, and ask-before-run rules should live in one permission plane.",
      },
      {
        title: "Always write back the outcome",
        body: "Allow, deny, and ask all need to flow back into the loop so the model can reason over what happened next.",
      },
    ],
    flowLabel: "Permission Pipeline",
    flow: ["Model proposes action", "Intent is classified", "Policy decides", "Execute or return denial"],
    cautionLabel: "Common mistake",
    caution:
      "Permission is not just a few if statements. It is a gate in front of execution with its own control-plane semantics.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A shared permission check that gives every tool the same allow / deny / ask contract.",
  },
  s08: {
    eyebrow: "Extend the loop without rewriting it",
    summary:
      "Hooks let you add audit trails, tracing, policy side effects, and instrumentation around the loop while keeping the loop itself small and legible.",
    sections: [
      {
        title: "The loop stays minimal",
        body: "Core state progression stays in the loop. Extra behavior hangs off lifecycle points like pre_tool, post_tool, and on_error.",
      },
      {
        title: "Events need a stable shape",
        body: "Hooks should receive normalized lifecycle events with tool name, input, result, error, and duration, not ad hoc strings.",
      },
      {
        title: "Side effects stay decoupled",
        body: "That keeps auditing, metrics, or repair hints from leaking into every tool implementation.",
      },
    ],
    flowLabel: "Lifecycle Events",
    flow: ["Loop advances", "Event emitted", "Hooks observe", "Side effects write back"],
    cautionLabel: "Common mistake",
    caution:
      "A hook system should observe and extend the loop, not secretly replace the loop's state machine.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A lifecycle event registry with multiple hooks attached to one stable execution loop.",
  },
  s09: {
    eyebrow: "Persist only what survives sessions",
    summary:
      "Memory is for cross-session facts that cannot be re-derived cheaply, not for storing every conversation turn forever.",
    sections: [
      {
        title: "Use typed memory buckets",
        body: "Preferences, project constraints, and durable environment facts should be separated from temporary observations.",
      },
      {
        title: "Read and write at clear moments",
        body: "Load relevant memory before prompt assembly. Extract and persist new memory after the work is done.",
      },
      {
        title: "Memory is not context",
        body: "Short-term messages carry the live process. Long-term memory keeps only compressed, durable facts.",
      },
    ],
    flowLabel: "Memory Lifecycle",
    flow: ["Load memory", "Assemble input", "Finish work", "Extract and persist"],
    cautionLabel: "Common mistake",
    caution:
      "Memory is not an infinite history log. The hard part is deciding what deserves to survive.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A clear separation between messages[], compacted summaries, and cross-session memory.",
  },
  s10: {
    eyebrow: "Prompting becomes an assembly pipeline",
    summary:
      "The system prompt should be taught as a pipeline that assembles stable policy, runtime state, tools, and memory in a predictable order.",
    sections: [
      {
        title: "Separate stable policy",
        body: "Role, safety rules, and non-negotiable constraints should not be tangled with temporary runtime details.",
      },
      {
        title: "Assemble runtime fragments explicitly",
        body: "Workspace state, available tools, memory, task state, and recovery hints need a visible assembly order.",
      },
      {
        title: "Input is a control plane",
        body: "The ordering and boundaries of prompt fragments control what the model sees and how it reasons.",
      },
    ],
    flowLabel: "Prompt Assembly",
    flow: ["Stable policy", "Runtime state", "Tool and memory injection", "Final model input"],
    cautionLabel: "Common mistake",
    caution:
      "Do not teach this as mystical prompt engineering. Teach data sources, assembly order, and information boundaries.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A prompt builder pipeline instead of a single giant prompt string.",
  },
  s11: {
    eyebrow: "Recovery keeps the system moving",
    summary:
      "A high-completion agent is not error-free. It is explicit about why it is retrying, degrading, or stopping after each failure.",
    sections: [
      {
        title: "Classify failures first",
        body: "Permission denials, tool crashes, missing dependencies, timeouts, and write conflicts should not all use the same retry branch.",
      },
      {
        title: "Continuation reasons stay explicit",
        body: "Before continuing, record whether this branch is a retry, fallback, or user-confirmation path.",
      },
      {
        title: "Recovery needs hard limits",
        body: "Caps on retries, fallback paths, and stop conditions prevent silent infinite loops.",
      },
    ],
    flowLabel: "Recovery Branches",
    flow: ["Failure detected", "Reason classified", "Recovery chosen", "Continue with context"],
    cautionLabel: "Common mistake",
    caution:
      "Recovery is not just a try/except wrapper. The recovery reason itself must become visible state.",
    outcomeLabel: "You should be able to build",
    outcome:
      "Explicit continuation reasons that make retry / fallback / stop into understandable state transitions.",
  },
  s12: {
    eyebrow: "Turn session steps into a durable work graph",
    summary:
      "The task system is not just a saved todo list. It turns work into durable records with dependency edges so progress can unlock later work across turns.",
    sections: [
      {
        title: "A task is a record before it is execution",
        body: "TaskRecord stores goal, state, and dependency edges. It answers what work exists and what is blocked, not what thread is currently running.",
      },
      {
        title: "Dependency edges must stay explicit",
        body: "Fields like blockedBy, blocks, and status make it clear why a task cannot start yet and which downstream work becomes eligible next.",
      },
      {
        title: "The board owns unlock logic",
        body: "The key runtime lesson is how completing one node updates the board, checks dependency satisfaction, and unlocks the next nodes.",
      },
    ],
    flowLabel: "Durable Task Graph",
    flow: ["Create task record", "Write dependency edges", "Complete current node", "Unlock downstream work"],
    cautionLabel: "Common mistake",
    caution:
      "A task is not a background thread and not a plan paragraph. It is a durable work record inside the system.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A minimal task board with dependency and unlock logic, not just a session-scoped todo list.",
  },
  s13: {
    eyebrow: "Separate goal records from running slots",
    summary:
      "The real lesson in background tasks is that the durable task goal stays on the board while each live execution gets its own runtime record and returns through notifications.",
    sections: [
      {
        title: "Running work needs its own record",
        body: "A RuntimeTaskRecord should carry id, status, started_at, result_preview, and output_file. It describes one execution attempt, not the task goal itself.",
      },
      {
        title: "Preview and full output should split",
        body: "Write the complete output to disk, then send only a preview back through notifications. The loop learns what happened without flooding prompt space.",
      },
      {
        title: "Notifications rejoin the main loop",
        body: "The background thread should not mutate model state directly. It writes runtime state and notifications, then the next turn injects them back into context.",
      },
    ],
    flowLabel: "Runtime Task Return Path",
    flow: ["Create runtime record", "Run in background", "Write preview and output", "Inject notification next turn"],
    cautionLabel: "Common mistake",
    caution:
      "A background task is not another thinking agent. What runs in parallel is waiting and execution, not the main loop itself.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A background execution path that returns through runtime records and notifications instead of blocking the foreground loop.",
  },
  s14: {
    eyebrow: "Time becomes another trigger source",
    summary:
      "Once tasks can run in the background, a scheduler should only decide when to trigger work. Execution still belongs to the runtime layer.",
    sections: [
      {
        title: "The scheduler only matches rules",
        body: "Cron owns time rules like hourly, daily, or weekdays. It should not directly own the runtime execution model.",
      },
      {
        title: "A trigger creates runtime work",
        body: "When a rule matches, generate the same kind of runtime task that other sources would create.",
      },
      {
        title: "Time and execution stay decoupled",
        body: "That lets you explain both why work started and how it moved through execution, retries, and completion.",
      },
    ],
    flowLabel: "Scheduled Trigger",
    flow: ["Cron tick", "Rule match", "Create runtime task", "Hand off to background runtime"],
    cautionLabel: "Common mistake",
    caution:
      "Do not reduce cron to a timer thread. The teaching value is the separation between trigger time and execution runtime.",
    outcomeLabel: "You should be able to build",
    outcome:
      "Separate schedule records from runtime task records and show how one hands off to the other.",
  },
  s15: {
    eyebrow: "Make teammates long-lived roles",
    summary:
      "Agent teams matter when specialists stop being disposable subtasks and become persistent identities with roles, inboxes, and repeatable responsibilities.",
    sections: [
      {
        title: "Identity comes before one task",
        body: "A teammate needs a name, role, status, and inbox. Its value comes from remaining available across multiple rounds of work.",
      },
      {
        title: "Mailbox boundaries keep coordination clear",
        body: "Teams should not share one giant messages[] buffer. Each worker has an inbox and its own execution line, then coordination travels through messages.",
      },
      {
        title: "The lead still owns orchestration",
        body: "The lead builds the roster, assigns work, and watches state. Team structure is what keeps persistence understandable instead of chaotic.",
      },
    ],
    flowLabel: "Persistent Team Loop",
    flow: ["Create teammate identity", "Deliver message", "Worker runs independently", "Reply or continue"],
    cautionLabel: "Common mistake",
    caution:
      "A teammate is not just a renamed subagent. The important difference is long-lived identity and repeatable collaboration.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A minimal team roster where persistent workers collaborate through mailboxes.",
  },
  s16: {
    eyebrow: "Upgrade coordination from chat to protocol",
    summary:
      "Team protocols matter because important coordination needs a fixed envelope, a request_id, and a durable request record, not just free-form text in a mailbox.",
    sections: [
      {
        title: "Protocol messages need a stable envelope",
        body: "type, from, to, request_id, and payload should travel together so one workflow can always be parsed and handled the same way.",
      },
      {
        title: "Requests should be durable records",
        body: "The real object to teach is the RequestRecord, not an in-memory tracker. Approval, shutdown, or handoff should survive long enough to inspect and resume.",
      },
      {
        title: "State transitions matter more than wording",
        body: "pending, approved, rejected, and expired are the actual teaching spine. The human-readable text is only the explanation layer around that state machine.",
      },
    ],
    flowLabel: "Protocol Request Lifecycle",
    flow: ["Send protocol request", "Persist request record", "Receive explicit response", "Update state and continue"],
    cautionLabel: "Common mistake",
    caution:
      "A protocol is not just more formal chat. It is a structured coordination path with request correlation and state transitions.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A small request / response protocol with durable request tracking.",
  },
  s17: {
    eyebrow: "Let workers self-claim and self-resume",
    summary:
      "Autonomy is not magic intelligence. It begins when a worker can poll for eligible work, restore the right context, and continue under clear claim rules.",
    sections: [
      {
        title: "Idle polling is the autonomy entry point",
        body: "During idle cycles, a worker checks inboxes, boards, or pending requests to discover whether something can now be claimed.",
      },
      {
        title: "Claim rules must stay explicit",
        body: "The system needs clear rules for what a worker may claim, how collisions are avoided, and when it should back off.",
      },
      {
        title: "Resume depends on visible state",
        body: "A worker does not continue from nowhere. It resumes from task state, protocol state, mailbox contents, and its own role state.",
      },
    ],
    flowLabel: "Autonomy Loop",
    flow: ["Enter idle poll", "Find claimable work", "Resume with context", "Write back state"],
    cautionLabel: "Common mistake",
    caution:
      "Autonomy does not mean uncontrolled motion. The important part is the claim policy and the state used to resume safely.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A worker loop that can discover, claim, and resume work without waiting for a new user turn.",
  },
  s18: {
    eyebrow: "Bind tasks to isolated execution lanes",
    summary:
      "Worktree isolation is not about git trivia. It is about giving each task a separate execution lane with explicit enter, run, and closeout lifecycle steps.",
    sections: [
      {
        title: "Tasks and lanes are different layers",
        body: "Tasks describe the goal. Worktrees describe where isolated execution happens. Keeping those layers separate prevents the runtime model from blurring.",
      },
      {
        title: "Lifecycle steps should stay explicit",
        body: "Allocate the worktree, enter the directory, run the work, then decide whether to keep or remove it during closeout.",
      },
      {
        title: "Lifecycle events make lanes observable",
        body: "Create, enter, and closeout events let the rest of the system observe execution-lane state instead of only seeing the final result.",
      },
    ],
    flowLabel: "Isolated Execution Lane",
    flow: ["Allocate worktree", "Enter isolated dir", "Run task", "Close out or keep"],
    cautionLabel: "Common mistake",
    caution:
      "A worktree is not the task system itself. It is an isolated, observable execution lane for a task.",
    outcomeLabel: "You should be able to build",
    outcome:
      "A task-to-worktree binding with explicit keep / remove closeout semantics.",
  },
  s19: {
    eyebrow: "External capability joins the same control plane",
    summary:
      "MCP and plugins matter because they extend the agent's capability bus without inventing a second execution universe.",
    sections: [
      {
        title: "Unify capability abstraction first",
        body: "Native tools, plugins, and MCP server actions should all enter the system through one capability view.",
      },
      {
        title: "External calls still pass policy",
        body: "Discovery, routing, permission checks, and recovery logic should apply to external capabilities too.",
      },
      {
        title: "Results return on the same bus",
        body: "Remote outputs should be normalized into the same tool_result or structured event format the loop already understands.",
      },
    ],
    flowLabel: "Capability Bus",
    flow: ["Discover capability", "Choose route", "Call external system", "Normalize and append"],
    cautionLabel: "Common mistake",
    caution:
      "Do not teach MCP as an isolated addon. The key is how it plugs back into the existing agent control plane.",
    outcomeLabel: "You should be able to build",
    outcome:
      "One capability-routing model that can explain native tools, plugins, and MCP servers together.",
  },
};

export function GenericSessionOverview({
  version,
  title,
}: {
  version: string;
  title?: string;
}) {
  const tLayer = useTranslations("layer_labels");
  const tSession = useTranslations("sessions");
  const meta = VERSION_META[version];

  if (!meta) return null;

  const copy = COPY[version];
  if (!copy) return null;

  return (
    <section className="min-h-[500px] space-y-4">
      <div
        className={`overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm ring-1 ${RING_CLASSES[meta.layer]}`}
      >
        <div
          className={`relative overflow-hidden bg-gradient-to-br ${SURFACE_CLASSES[meta.layer]} px-5 py-6 sm:px-6`}
        >
          <div className="absolute right-[-40px] top-[-40px] h-36 w-36 rounded-full bg-white/40 blur-3xl dark:bg-white/5" />
          <div className="relative">
            <div className="flex flex-wrap items-center gap-2">
              <LayerBadge layer={meta.layer}>{tLayer(meta.layer)}</LayerBadge>
              <span className="rounded-full border border-white/50 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-zinc-700 backdrop-blur dark:border-white/10 dark:bg-zinc-950/40 dark:text-zinc-300">
                {copy.eyebrow}
              </span>
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
              {title || tSession(version)}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-zinc-700 dark:text-zinc-300">
              {copy.summary}
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-zinc-200/70 bg-white/85 px-3 py-2 text-xs text-zinc-600 backdrop-blur dark:border-zinc-700/70 dark:bg-zinc-950/50 dark:text-zinc-300">
              <span className="font-medium">Core Addition</span>
              <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {meta.coreAddition}
              </span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 px-5 py-5 sm:grid-cols-3 sm:px-6">
          {copy.sections.map((section, index) => (
            <motion.div
              key={section.title}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.08, duration: 0.32 }}
              className="rounded-2xl border border-zinc-200/80 bg-white/90 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60"
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
                0{index + 1}
              </div>
              <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {section.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {section.body}
              </p>
            </motion.div>
          ))}
        </div>

        <div className="grid gap-4 border-t border-[var(--color-border)] px-5 py-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] sm:px-6">
          <div className="rounded-2xl border border-zinc-200/80 bg-zinc-50/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {copy.flowLabel}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {copy.flow.map((step, index) => (
                <div key={step} className="contents">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: index * 0.07, duration: 0.28 }}
                    className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    <span className="mr-2 font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                      {index + 1}
                    </span>
                    {step}
                  </motion.div>
                  {index < copy.flow.length - 1 && (
                    <span className="text-zinc-300 dark:text-zinc-600">-&gt;</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3">
            <div className="rounded-2xl border border-zinc-200/80 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {copy.cautionLabel}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                {copy.caution}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200/80 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
              <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {copy.outcomeLabel}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                {copy.outcome}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
