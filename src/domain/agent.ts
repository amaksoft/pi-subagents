/**
 * domain/agent.ts — pure agent settle decision (Phase-1 strangler).
 *
 * The aborted > error > steered > completed precedence used to live as
 * if-ordering split between runAgent's flags and four settle call sites in
 * the manager (spawn then/catch, two resume then/catch pairs) — each with a
 * slightly different shape. This module is the single owner of "given how the
 * run ended, what status (and error) results". The manager applies the
 * decision; timestamps, notifications, and slots stay outside.
 *
 * Two preserved quirks (pinned by tests, not sanctified):
 * - Spawn-path rejections assign `error` even when stopped (resume paths
 *   don't): `keepErrorWhenStopped` carries that difference explicitly.
 * - `failure: ""` counts as no failure (truthiness, matching the old
 *   `else if (failure)`).
 */

import type { Pool } from "./queue.js";

export type AgentSettleStatus = "completed" | "steered" | "aborted" | "error" | "stopped";

/**
 * A run that never started: worktree creation, cwd validation, or session
 * setup failed before kickoff. Carries which path it took — queued spawns
 * park the failure on the record (nobody is awaiting), immediate spawns
 * travel through the startups channel and rethrow out of spawnAndWait
 * (#179: pi only fails a tool call on throw). Single construction site
 * (failStartup in the manager); use instanceof to tell startup failure
 * from run failure.
 */
export class StartupError extends Error {
  /** The pool whose queue parked this start, or undefined for immediate. */
  readonly queuedPool: Pool | undefined;

  constructor(message: string, opts: { cause?: unknown; queuedPool?: Pool }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "StartupError";
    this.queuedPool = opts.queuedPool;
  }
}

export type SettleInput =
  | {
      kind: "resolved";
      /** Record already stopped by an external abort: keep it, touch nothing else. */
      stopped: boolean;
      aborted: boolean;
      steered: boolean;
      failure?: string;
    }
  | {
      kind: "rejected";
      stopped: boolean;
      error: string;
      /**
       * Spawn path assigns the rejection error even onto stopped records
       * (surfacing abort noise where "Stopped." would do); resume paths
       * assign only onto non-stopped records.
       */
      keepErrorWhenStopped: boolean;
    };

export interface SettleDecision {
  status: AgentSettleStatus;
  /** Present only when the caller must (over)write record.error. */
  error?: string;
}

export function reduceSettle(input: SettleInput): SettleDecision {
  if (input.kind === "rejected") {
    if (input.stopped) {
      return input.keepErrorWhenStopped ? { status: "stopped", error: input.error } : { status: "stopped" };
    }
    return { status: "error", error: input.error };
  }
  if (input.stopped) return { status: "stopped" };
  if (input.aborted) return { status: "aborted" };
  if (input.failure) return { status: "error", error: input.failure };
  return { status: input.steered ? "steered" : "completed" };
}
