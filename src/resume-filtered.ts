/**
 * resume-filtered.ts — `/resume-filtered`: a resume picker without subagent noise.
 *
 * Core's `/resume` is hardcoded ahead of extension-command dispatch, so it can
 * neither be filtered nor collapsed from here (its tree is always fully
 * flattened). This parallel command reads the same store through
 * `SessionManager.list`/`listAll` and drops every session that carries a
 * `parentSessionPath` — subagent spawns record their spawner there, so that
 * single predicate is exactly "was this session spawned by another session".
 * The pick switches via `ctx.switchSession`, the same call core's picker uses.
 *
 * Scope mirrors core: current-folder sessions by default, `all` for the whole
 * store (`/resume-filtered all`, like core's Tab scope toggle).
 */

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { selectItem } from "./ui/select-item.js";

/** Minimal session shape this needs (structural subset of SessionInfo). */
export interface ResumeSession {
  path: string;
  name?: string;
  parentSessionPath?: string;
  messageCount: number;
  modified: Date;
  firstMessage: string;
}

/** Collaborators, injected so the flow is testable without pi. */
export interface ResumeFilteredDeps {
  listCurrent(): Promise<ResumeSession[]>;
  listAll(): Promise<ResumeSession[]>;
  /** Absolute path of the session the command runs in, if known. */
  currentSessionFile?: () => string | undefined;
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  switchSession(path: string): Promise<{ cancelled: boolean }>;
}

/**
 * Whether a session is a spawned child (subagent run) rather than an
 * interactive conversation. Pure — the whole filter rests on this.
 */
export function isSubagentSession(session: Pick<ResumeSession, "parentSessionPath">): boolean {
  return !!session.parentSessionPath;
}

/** `just now` / `5m` / `3h` / `4d` — compact age for picker rows. */
export function formatResumeAge(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Row text: name (or first message) plus message count and age. */
export function formatResumeRow(session: ResumeSession, now = Date.now(), currentFile?: string): string {
  const text = (session.name?.trim() || session.firstMessage).replace(/\s+/g, " ").trim().slice(0, 80) || "(empty session)";
  const age = formatResumeAge(now - session.modified.getTime());
  const current = currentFile !== undefined && session.path === currentFile ? " · current" : "";
  return `${text} · ${session.messageCount} msgs · ${age}${current}`;
}

export async function runResumeFiltered(deps: ResumeFilteredDeps, args: string): Promise<void> {
  const scopeAll = args.trim().toLowerCase() === "all";
  let sessions: ResumeSession[];
  try {
    sessions = scopeAll ? await deps.listAll() : await deps.listCurrent();
  } catch (err) {
    deps.notify(`Could not list sessions: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  const hiddenCount = sessions.filter(isSubagentSession).length;
  const visible = sessions.filter(s => !isSubagentSession(s));
  if (visible.length === 0) {
    deps.notify(
      hiddenCount > 0
        ? `No interactive sessions found — hid ${hiddenCount} subagent session${hiddenCount === 1 ? "" : "s"}. Core /resume still lists everything.`
        : "No sessions found.",
      "info",
    );
    return;
  }
  const currentFile = deps.currentSessionFile?.();
  const picked = await selectItem(
    deps,
    scopeAll ? "Resume session (all folders, no subagents)" : "Resume session (no subagents)",
    visible,
    s => formatResumeRow(s, Date.now(), currentFile),
  );
  if (!picked) return; // escaped
  try {
    await deps.switchSession(picked.path);
  } catch (err) {
    deps.notify(`Could not resume session: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Adapt a full SessionInfo to the structural subset (drops nothing). */
export function toResumeSession(info: SessionInfo): ResumeSession {
  return {
    path: info.path,
    name: info.name,
    parentSessionPath: info.parentSessionPath,
    messageCount: info.messageCount,
    modified: info.modified,
    firstMessage: info.firstMessage,
  };
}
