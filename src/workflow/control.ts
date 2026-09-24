/**
 * workflow/control.ts — pure helpers for the main session's workflow controls.
 *
 * Workflow children belong to their run: the top-level stop/steer/result
 * tools refuse them, so the main session reaches them here — addressed by
 * (runId, label|index), executed through the same control.* transitions the
 * dialog uses (identical barrier/journal accounting, no new settle paths).
 * Pure and tested directly; index.ts wires manager + tasks around it.
 */
import { describeStall, formatStallAge } from "../status-note.js";
import type { AgentRecord } from "../types.js";
import { collapse, displayState, isLive, type WorkflowEntry } from "./progress.js";

export interface WorkflowAgentRef {
  label?: string;
  index?: number;
}

export interface WorkflowAgentEntryLike {
  index: number;
  label: string;
}

export type AgentResolution =
  | { ok: true; index: number }
  | { ok: false; message: string };

/**
 * Resolve a human reference to a runtime agent index. Index wins when both
 * are given (labels repeat across phases); labels match exactly, then
 * case-insensitively; ambiguity errors list the candidates.
 */
export function resolveWorkflowAgent(
  entries: readonly WorkflowAgentEntryLike[],
  ref: WorkflowAgentRef,
): AgentResolution {
  if (ref.index !== undefined) {
    const hit = entries.find(e => e.index === ref.index);
    if (!hit) {
      const known = entries.map(e => e.index).join(", ");
      return { ok: false, message: `No workflow agent at index ${ref.index}. Known: ${known || "(none)"}.` };
    }
    return { ok: true, index: hit.index };
  }
  const label = ref.label?.trim();
  if (!label) {
    return { ok: false, message: "Name a label or index — see the status listing." };
  }
  const exact = entries.filter(e => e.label === label);
  if (exact.length === 1) return { ok: true, index: exact[0].index };
  const folded = entries.filter(e => e.label.toLowerCase() === label.toLowerCase());
  if (folded.length === 1) return { ok: true, index: folded[0].index };
  const pool = (exact.length > 0 ? exact : folded.length > 0 ? folded : entries)
    .map(e => `#${e.index} ${e.label}`);
  return {
    ok: false,
    message: exact.length > 1 || folded.length > 1
      ? `Ambiguous label "${label}" — say the index: ${pool.join("; ")}.`
      : `No workflow agent labeled "${label}". Known: ${pool.join("; ") || "(none)"}.`,
  };
}

export interface RunStatusInput {
  id: string;
  status: string;
  name: string;
  progress: readonly WorkflowEntry[];
}

/**
 * Render one run's agent listing for `workflow_control status`.
 *
 * Collapses through the same last-write-wins fold the dialog uses, then leads
 * with a judge summary (settled count, barrier state, exact next action) so a
 * skimming session gets the verdict from the first two lines. Pure apart from
 * the record reads; tested directly (see the wf_0435 replay test: 39 settled +
 * 1 wedged must render 40 rows and a BARRIER HELD line, not 200 stale rows).
 */
export function renderRunStatus(
  run: RunStatusInput,
  getRecord: (recordId: string) => AgentRecord | undefined,
  thresholdMs: number,
  now = Date.now(),
): string {
  const { agents } = collapse(run.progress);
  if (agents.length === 0) return `Run ${run.id} [${run.status}]: no agents yet.`;
  const active = run.status === "running";
  const stallOf = new Map<number, string>();
  let lastProgress = 0;
  for (const a of agents) {
    if (typeof a.lastProgressAt === "number") lastProgress = Math.max(lastProgress, a.lastProgressAt);
    const rec = a.recordId ? getRecord(a.recordId) : undefined;
    const stall = rec ? describeStall(rec, now, thresholdMs) : undefined;
    if (stall) stallOf.set(a.index, stall);
  }
  const open = agents.filter(a => isLive(a));
  const done = agents.length - open.length;
  const openStalled = open.filter(a => stallOf.has(a.index));
  const openQueued = open.filter(a => displayState(a, active) === "queued");
  const idleMs = lastProgress > 0 ? Math.max(0, now - lastProgress) : 0;
  const head =
    `Run ${run.id} [${run.status}] ${run.name} — ${done}/${agents.length} agents settled` +
    (open.length === 0
      ? " (all settled)"
      : openStalled.length === open.length
        ? ` · BARRIER HELD by ${open.length} stalled: ${open.map(a => `#${a.index}`).join(", ")} (no progress for ${formatStallAge(idleMs)})`
        : ` · ${open.length} open (${openStalled.length} stalled` +
          (openQueued.length > 0 ? `, ${openQueued.length} queued behind the run limit` : "") +
          `), no progress for ${formatStallAge(idleMs)}`);
  const advice =
    open.length === 0
      ? []
      : openStalled.length > 0
        ? [
            `→ stop_agent ${openStalled.map(a => `#${a.index}`).join(" ")} to release the barrier (resolves null, siblings proceed), or retry_agent with a narrowed prompt.`,
          ]
        : [
            `→ ${open.length} agents open but moving (last progress ${formatStallAge(idleMs)} ago); leave it or stop_run to settle.`,
          ];
  return (
    [head, ...advice].join("\n") +
    "\n" +
    agents
      .map(a => {
        const stall = stallOf.get(a.index);
        const bits = [`#${a.index} ${a.label}`, displayState(a, active)];
        if (a.attempt !== undefined && a.attempt > 1) bits.push(`attempt ${a.attempt}`);
        if (stall) bits.push(stall);
        if (a.error) bits.push(`error: ${a.error.slice(0, 120)}`);
        else if (a.resultPreview) bits.push(`output: ${a.resultPreview.slice(0, 120)}`);
        return bits.join(" · ");
      })
      .join("\n")
  );
}

/**
 * Evidence brief for one workflow agent: the judge's instrument for ruling on
 * a straggler. Composes everything the manager record knows (stall, current
 * tool + elapsed, activity/output ages, live tail) with the entry's own state,
 * so `inspect` answers "is it working or wedged" without the session having
 * to guess from a one-line status row. Pure apart from the single record read
 * the caller performs; settled and never-spawned agents render honestly too.
 */
export function renderAgentInspect(
  entry: import("./progress.js").WorkflowAgentEntry,
  record: AgentRecord | undefined,
  thresholdMs: number,
  now = Date.now(),
): string {
  const lines = [`#${entry.index} ${entry.label} · ${entry.state}`];
  if (entry.attempt !== undefined && entry.attempt > 1) lines[0] += ` · attempt ${entry.attempt}`;
  if (entry.model) lines[0] += ` · ${entry.model}`;
  if (entry.state === "done" || (entry.state === "error" && (entry.skipped || entry.error))) {
    if (entry.error) lines.push(`error: ${entry.error.slice(0, 500)}`);
    else if (entry.resultPreview) lines.push(`output: ${entry.resultPreview.slice(0, 2000)}`);
    else lines.push("settled with no recorded output.");
    return lines.join("\n");
  }
  if (!record) {
    if (entry.startedAt == null && entry.queuedAt != null) {
      lines.push(`parked behind the run's concurrency limit for ${formatStallAge(Math.max(0, now - entry.queuedAt))} — never spawned, nothing to diagnose.`);
    } else {
      lines.push("no manager record (spawned before this session, or swept) — only the journal preview survives.");
      if (entry.resultPreview) lines.push(`preview: ${entry.resultPreview.slice(0, 500)}`);
    }
    return lines.join("\n");
  }
  const stall = describeStall(record, now, thresholdMs);
  lines.push(stall ?? `not stalled — last activity ${formatStallAge(Math.max(0, now - record.lastActivityAt))} ago.`);
  if (record.currentTool) {
    lines.push(
      `in ${record.currentTool.name} for ${formatStallAge(Math.max(0, now - record.currentTool.startedAt))}` +
        (record.lastOutputAt !== undefined
          ? ` · last output ${formatStallAge(Math.max(0, now - record.lastOutputAt))} ago`
          : " · no output yet"),
    );
  } else if (record.reasoningSince !== undefined) {
    lines.push(`reasoning for ${formatStallAge(Math.max(0, now - record.reasoningSince))} (no tool running).`);
  } else {
    lines.push("between tools, idle.");
  }
  lines.push(`tool uses: ${record.toolUses} · stalled-since flag: ${record.stalledSince !== undefined ? formatStallAge(Math.max(0, now - record.stalledSince)) : "not flagged"}.`);
  if (record.liveOutput) lines.push(`live tail:\n${record.liveOutput.slice(-2000)}`);
  return lines.join("\n");
}

export interface StalledChild {
  index: number;
  label: string;
  stall: string;
  episodes: number;
}

/**
 * Live stalled children of one run, for the run-level check-in. Collapsed
 * (one row per index, like status) and joined against live manager records:
 * a settled-and-swept child contributes nothing, a parked one was never
 * stalled. Pure; the caller throttles notification by the returned key.
 */
export function stalledChildrenOf(
  progress: readonly WorkflowEntry[],
  getRecord: (recordId: string) => AgentRecord | undefined,
  thresholdMs: number,
  now = Date.now(),
): StalledChild[] {
  const { agents } = collapse(progress);
  const out: StalledChild[] = [];
  for (const a of agents) {
    if (!isLive(a) || !a.recordId) continue;
    const rec = getRecord(a.recordId);
    const stall = rec ? describeStall(rec, now, thresholdMs) : undefined;
    if (stall) out.push({ index: a.index, label: a.label, stall, episodes: rec?.stallEpisodes ?? 1 });
  }
  return out.sort((x, y) => x.index - y.index);
}

/**
 * Throttle key for the run-level check-in: the stalled set plus each
 * member's episode count. A newly wedged child changes the set; a re-flag
 * after a snooze bumps an episode — either re-notifies, anything else stays
 * silent. Opaque to callers; stored per run by the host.
 */
export function stallCheckinKey(stalled: readonly StalledChild[]): string {
  return stalled.map(s => `${s.index}e${s.episodes}`).join(",");
}
