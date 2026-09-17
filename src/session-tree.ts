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

function rowText(session: ResumeSession): string {
  return `${session.name?.trim() ?? ""} ${session.firstMessage}`.replace(/\s+/g, " ").trim().toLowerCase();
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
    });
    for (const child of node.children) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  return rows;
}
