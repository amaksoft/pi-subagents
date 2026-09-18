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
import { attachExternalParents, buildSessionTree, groupIdenticalRoots, sanitizeRowText, type SessionTreeNode } from "./session-tree.js";
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
  /**
   * Resolve an absent parent path to a display session for the stub row.
   * Without it, orphans whose parent lives in another scope (or is gone)
   * stay as plain roots.
   */
  resolveExternalParent?: (parentPath: string) => ResumeSession | undefined;
  /**
   * Collapsible tree picker (tui only). When supplied, subagent sessions are
   * kept as collapsed children instead of filtered out; without it (non-tui
   * modes) the command falls back to the filtered flat list.
   */
  pickFromTree?: (roots: SessionTreeNode[]) => Promise<string | undefined>;
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
  const text = sanitizeRowText(session.name?.trim() || session.firstMessage) || "(empty session)";
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
  if (sessions.length === 0) {
    deps.notify("No sessions found.", "info");
    return;
  }
  const currentFile = deps.currentSessionFile?.();
  if (deps.pickFromTree) {
    // Tree mode: relations preserved, children collapsed by default. Nothing
    // is hidden — subagent runs sit under their spawner with a count badge,
    // and repeated parentless runs (probe harnesses, retried prompts) fold
    // into one expandable group row each.
    const forest = buildSessionTree(sessions);
    const withExternals = deps.resolveExternalParent
      ? attachExternalParents(forest, deps.resolveExternalParent)
      : forest;
    const picked = await deps.pickFromTree(groupIdenticalRoots(withExternals));
    if (!picked) return; // escaped
    try {
      await deps.switchSession(picked);
    } catch (err) {
      deps.notify(`Could not resume session: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return;
  }
  // Non-tui fallback: the flat select dialog (no windowing there either, but
  // print/rpc output is consumed as text, not navigated).
  const hiddenCount = sessions.filter(isSubagentSession).length;
  const visible = sessions.filter(s => !isSubagentSession(s));
  if (visible.length === 0) {
    deps.notify(
      `No interactive sessions found — hid ${hiddenCount} subagent session${hiddenCount === 1 ? "" : "s"}. Core /resume still lists everything.`,
      "info",
    );
    return;
  }
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

/**
 * Merge per-scope listings (default dir + segregated subagent dir) into one
 * list, deduplicated by path. A file belongs to exactly one dir, so this is
 * safety rather than logic — but two loaders must never double a row.
 */
export function mergeSessionLists(lists: ResumeSession[][]): ResumeSession[] {
  const seen = new Map<string, ResumeSession>();
  for (const list of lists) for (const s of list) if (!seen.has(s.path)) seen.set(s.path, s);
  return [...seen.values()];
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
