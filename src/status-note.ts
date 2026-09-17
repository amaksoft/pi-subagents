/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import type { AgentRecord } from "./types.js";

/** Whether an agent record can still be stopped (running or queued). */
export function isStoppableStatus(status: string): boolean {
  return status === "running" || status === "queued";
}

/**
 * Stall visibility for hung agents (e.g. a tool call wedged on blocked
 * network with no timeout). The record already counts tool *ends*; what was
 * missing is any notion of a tool *start* without an end — this closes it.
 *
 * Active statuses only: a terminal record with an old heartbeat is finished,
 * not stuck. `stalledSince` is set by the manager's periodic sweep and
 * cleared by any activity, so it is a display flag, never a status.
 */

/** Default stall threshold: ten minutes without any sign of life. */
export const DEFAULT_STALL_THRESHOLD_MS = 10 * 60_000;

/** Minimal activity shape — structural so this module stays import-cycle-free. */
export interface ToolActivityLike {
  type: "start" | "end";
  toolName: string;
}

/**
 * Record one tool event on the agent heartbeat. Start sets currentTool,
 * end clears it and bumps the use count; both refresh lastActivityAt and
 * clear a previously flagged stall. Call from every onToolActivity handler.
 */
export function trackToolActivity(
  record: Pick<AgentRecord, "toolUses" | "lastActivityAt" | "currentTool" | "stalledSince">,
  activity: ToolActivityLike,
): void {
  const now = Date.now();
  if (activity.type === "start") {
    record.currentTool = { name: activity.toolName, startedAt: now };
  } else {
    record.currentTool = undefined;
    record.toolUses++;
  }
  record.lastActivityAt = now;
  record.stalledSince = undefined;
}

/**
 * Heartbeat for non-tool signs of life (streamed text deltas, usage updates).
 * A long model stream with no tool calls is alive, not stalled.
 */
export function touchActivity(
  record: Pick<AgentRecord, "lastActivityAt" | "stalledSince">,
): void {
  record.lastActivityAt = Date.now();
  record.stalledSince = undefined;
}

/** Milliseconds since the record's last sign of life (floor 0). */
export function stallElapsedMs(
  record: Pick<AgentRecord, "lastActivityAt">,
  now = Date.now(),
): number {
  return Math.max(0, now - record.lastActivityAt);
}

/** True when a running agent has been silent past the threshold.
 * Queued agents are never stalled: their silence is waiting, not wedging —
 * and the auto-abort below must never kill work that hasn't started. */
export function isStalled(
  record: Pick<AgentRecord, "status" | "lastActivityAt">,
  now = Date.now(),
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
): boolean {
  if (record.status !== "running") return false;
  return stallElapsedMs(record, now) >= thresholdMs;
}

/**
 * One-line stall diagnosis for status surfaces (FleetView, get_subagent_result):
 * "stalled 22m in bash" / "stalled 22m, idle (no tool running)".
 * Undefined when not stalled.
 */
export function describeStall(
  record: Pick<AgentRecord, "status" | "lastActivityAt" | "currentTool">,
  now = Date.now(),
  thresholdMs = DEFAULT_STALL_THRESHOLD_MS,
): string | undefined {
  if (!isStalled(record, now, thresholdMs)) return undefined;
  const mins = Math.max(1, Math.round(stallElapsedMs(record, now) / 60_000));
  const where = record.currentTool
    ? ` in ${record.currentTool.name}`
    : ", idle (no tool running)";
  return `stalled ${mins}m${where}`;
}

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` is deliberately distinct from `aborted` (the turn limit was hit) —
 * the parent should treat an intervention differently from a budget cutoff.
 * Deliberately actor-neutral: stops arrive from the model (stop tools),
 * the human (FleetView, viewer, Esc), RPC peers, and abortAll, and the note
 * cannot tell which. An earlier wording named the user; that lied on every
 * non-human path and could suppress a legitimate retry ("a human killed it,
 * don't restart") exactly where the stopper itself was about to try again.
 */
export function getStatusNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because an
 * intervention outranks everything else in the string — whatever stopped the
 * run, the task is unfinished and the output is a fragment. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
