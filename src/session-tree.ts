/**
 * session-tree.ts — parent/child session tree for the resume picker.
 *
 * Core's /resume threads subagent sessions under their spawner via
 * `parentSessionPath` but always renders the whole tree expanded, and the
 * generic `ctx.ui.select` dialog has no windowing at all (it renders every
 * option and rebuilds them per keypress — broken at our session counts).
 * This module is the pure model for our own collapsible picker: build the
 * same tree core builds, then flatten only what's visible.
 *
 * All functions are pure and tested directly; the TUI component lives in
 * ui/resume-tree-picker.ts.
 */

import type { ResumeSession } from "./resume-filtered.js";

export interface SessionTreeNode {
  session: ResumeSession;
  children: SessionTreeNode[];
  /** Total descendants (children + below), for "N subagent runs" badges. */
  descendantCount: number;
  /** Set on synthetic duplicate-group nodes (see groupIdenticalRoots). */
  groupKey?: string;
  /** Set on synthetic external-scope parents (see attachExternalParents). */
  externalScope?: string;
}

export interface TreeRow {
  session: ResumeSession;
  depth: number;
  /** Node has children (expandable), regardless of current state. */
  isParent: boolean;
  /** Node is currently expanded (meaningful only when isParent). */
  expanded: boolean;
  /** Descendants hidden by collapse (0 when expanded or childless). */
  collapsedCount: number;
  /** Search hit context: shown dimmed, not itself a match. */
  dimmed?: boolean;
  /** Synthetic duplicate-group row: Enter expands instead of resuming. */
  isGroup?: boolean;
  /** Synthetic external-scope parent: label gains a scope suffix. */
  externalScope?: string;
}

/**
 * Build the forest from parentSessionPath links. Sessions whose parent is
 * absent from the listing (deleted, other scope, legacy) become roots — same
 * rule core's buildSessionTree uses. Roots and children sort by modified,
 * newest first.
 */
export function buildSessionTree(sessions: ResumeSession[]): SessionTreeNode[] {
  const byPath = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    byPath.set(session.path, { session, children: [], descendantCount: 0 });
  }
  const roots: SessionTreeNode[] = [];
  for (const session of sessions) {
    const node = byPath.get(session.path)!;
    const parent = session.parentSessionPath ? byPath.get(session.parentSessionPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const finish = (node: SessionTreeNode): number => {
    let count = 0;
    for (const child of node.children) count += 1 + finish(child);
    node.children.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    node.descendantCount = count;
    return count;
  };
  for (const root of roots) finish(root);
  roots.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
  return roots;
}

/**
 * Flatten to visible rows. `expanded` holds paths of expanded parents;
 * everything else stays collapsed, so the default (empty set) shows roots
 * only — the "load collapsed" behavior.
 */
export function visibleRows(roots: SessionTreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: SessionTreeNode, depth: number) => {
    const isParent = node.children.length > 0;
    const isExpanded = isParent && expanded.has(node.session.path);
    rows.push({
      session: node.session,
      depth,
      isParent,
      expanded: isExpanded,
      collapsedCount: isParent && !isExpanded ? node.descendantCount : 0,
      ...(node.groupKey !== undefined ? { isGroup: true } : {}),
      ...(node.externalScope !== undefined ? { externalScope: node.externalScope } : {}),
    });
    if (isExpanded) for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

/** Toggle a path in the expanded set. Returns a new set (pure). */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Normalized searchable text per session, memoized: search re-runs per
 * keystroke, and re-normalizing hundreds of first messages each time is the
 * O(N) the picker cache above still pays without this. Sessions are stable
 * for a picker's lifetime, so a WeakMap never goes stale here. */
const normCache = new WeakMap<ResumeSession, string>();
function rowText(session: ResumeSession): string {
  const hit = normCache.get(session);
  if (hit !== undefined) return hit;
  const norm = `${session.name?.trim() ?? ""} ${session.firstMessage}`.replace(/\s+/g, " ").trim().toLowerCase();
  normCache.set(session, norm);
  return norm;
}

/**
 * Nest orphans whose parent lives outside the listing (another scope dir,
 * e.g. a devmate session) under a synthetic stub row, so they read as what
 * they are — spawned children — instead of root-level interactive sessions.
 * `resolve` maps an absent parent path to a display session (name/cwd from
 * its header); unresolvable parents (deleted files) stay as plain roots.
 * The stub carries the real parent path, so Enter resumes it like any row.
 * Pure — tested directly.
 */
export function attachExternalParents(
  roots: SessionTreeNode[],
  resolve: (parentPath: string) => ResumeSession | undefined,
): SessionTreeNode[] {
  const known = new Set(roots.map(r => r.session.path));
  const byParent = new Map<string, SessionTreeNode[]>();
  for (const root of roots) {
    const p = root.session.parentSessionPath;
    if (p && !known.has(p)) {
      const bucket = byParent.get(p);
      if (bucket) bucket.push(root);
      else byParent.set(p, [root]);
    }
  }
  if (byParent.size === 0) return roots;
  const stubbed = new Set<string>();
  const stubs = new Map<string, SessionTreeNode>();
  for (const [parentPath, orphans] of byParent) {
    const stub = resolve(parentPath);
    if (!stub) continue;
    const sorted = [...orphans].sort(
      (a, b) => b.session.modified.getTime() - a.session.modified.getTime(),
    );
    stubs.set(parentPath, {
      session: stub,
      children: sorted,
      descendantCount: sorted.length,
      externalScope: scopeLabel(parentPath),
    });
    for (const o of orphans) stubbed.add(o.session.path);
  }
  if (stubs.size === 0) return roots;
  // Emit each stub at its first orphan's position; drop stubbed orphans.
  const emitted = new Set<string>();
  const out: SessionTreeNode[] = [];
  for (const root of roots) {
    const p = root.session.parentSessionPath;
    if (p && stubs.has(p)) {
      if (emitted.has(p)) continue;
      emitted.add(p);
      out.push(stubs.get(p)!);
      continue;
    }
    if (stubbed.has(root.session.path)) continue;
    out.push(root);
  }
  return out;
}

/** Short scope label from a session path, e.g. `devmate` from `…/sessions/devmate/x.jsonl`. */
export function scopeLabel(sessionPath: string): string {
  const m = sessionPath.replace(/\\/g, "/").match(/\/sessions\/([^/]+)\//);
  return m ? m[1] : "another scope";
}

/**
 * Strip ANSI escapes, C0/C1 controls and DEL from session-sourced text
 * before it reaches picker rows: names and first messages are model- and
 * file-authored, and a raw ESC `[2J` in a row would rewrite the reader's
 * terminal. Truncates to a picker-safe width.
 */
export function sanitizeRowText(text: string, maxLen = 80): string {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Normalized first user message — the duplicate-grouping key. Memoized
 * like rowText: grouping walks every root twice (bucket + rebuild). */
const keyCache = new WeakMap<ResumeSession, string>();
export function firstMessageKey(session: ResumeSession): string {
  const hit = keyCache.get(session);
  if (hit !== undefined) return hit;
  const key = session.firstMessage.replace(/\s+/g, " ").trim();
  keyCache.set(session, key);
  return key;
}

/**
 * Collapse parentless roots with identical first messages into synthetic
 * group nodes ("list the files in /tmp ×16"). Probe/eval harnesses and
 * retried prompts produce these; they are the same run repeated, so one row
 * stands for all, expandable to individuals. Only parentless roots group:
 * linked children already hide under their (collapsed) parent, and grouping
 * them would break the tree relations. Singles pass through untouched.
 * Pure — tested directly.
 */
export function groupIdenticalRoots(roots: SessionTreeNode[]): SessionTreeNode[] {
  const byKey = new Map<string, SessionTreeNode[]>();
  for (const root of roots) {
    // Linked roots (forks, orphans with a recorded parent) keep their row:
    // their identity is the link, not the text.
    if (root.session.parentSessionPath) continue;
    const key = firstMessageKey(root.session);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(root);
    else byKey.set(key, [root]);
  }
  // Rebuild in original order, emitting each group at its first member's
  // position.
  const emitted = new Set<string>();
  const out: SessionTreeNode[] = [];
  for (const root of roots) {
    if (root.session.parentSessionPath || !firstMessageKey(root.session)) {
      out.push(root);
      continue;
    }
    const key = firstMessageKey(root.session);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const members = byKey.get(key)!;
    out.push(members.length < 2 ? members[0] : makeGroupNode(key, members));
  }
  return out;
}

/** Synthetic parent whose children are the duplicate runs, newest first. */
function makeGroupNode(key: string, members: SessionTreeNode[]): SessionTreeNode {
  const sorted = [...members].sort(
    (a, b) => b.session.modified.getTime() - a.session.modified.getTime(),
  );
  const latest = sorted[0].session;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return {
    session: {
      // Stable, unresumable pseudo-path: the picker expands groups on Enter
      // instead of resuming (see isGroup), so this never reaches switchSession.
      path: `duplicate:${hash.toString(36)}`,
      name: latest.name,
      parentSessionPath: undefined,
      messageCount: sorted.reduce((n, m) => n + m.session.messageCount, 0),
      modified: latest.modified,
      firstMessage: latest.firstMessage,
    },
    children: sorted,
    descendantCount: sorted.length,
    groupKey: key,
  };
}

/**
 * Search view: matching rows plus their ancestor chain (dimmed, auto-shown),
 * so hits keep their parent context. Collapse state is ignored while a query
 * is active — filtering already narrows the list.
 */
export function searchRows(roots: SessionTreeNode[], query: string): TreeRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return visibleRows(roots, new Set());
  // Two-pass to preserve document order: first compute the matched set…
  const rows: TreeRow[] = [];
  const matched = new Set<string>();
  const mark = (node: SessionTreeNode): boolean => {
    const self = rowText(node.session).includes(q);
    let under = false;
    for (const child of node.children) under = mark(child) || under;
    if (self || under) {
      matched.add(node.session.path);
      if (self) matched.add(`hit:${node.session.path}`);
      return true;
    }
    return false;
  };
  for (const root of roots) mark(root);
  // …then emit matched nodes with ancestors, depth-first.
  const emit = (node: SessionTreeNode, depth: number) => {
    if (!matched.has(node.session.path)) return;
    rows.push({
      session: node.session,
      depth,
      isParent: node.children.length > 0,
      expanded: true,
      collapsedCount: 0,
      dimmed: !matched.has(`hit:${node.session.path}`),
      ...(node.groupKey !== undefined ? { isGroup: true } : {}),
      ...(node.externalScope !== undefined ? { externalScope: node.externalScope } : {}),
    });
    for (const child of node.children) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  return rows;
}
