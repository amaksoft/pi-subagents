/**
 * resume-tree-picker.ts — collapsible session tree picker for /resume-filtered.
 *
 * Core's /resume always renders its whole parent/child tree expanded, and the
 * generic ctx.ui.select dialog has no windowing at all (renders every option,
 * rebuilt per keypress — unusable at our session counts). This overlay keeps
 * core's tree relations but loads collapsed: roots only, each parent badged
 * with its hidden child count. For use with ctx.ui.custom; falls back to the
 * flat selectItem list outside tui mode (see resume-filtered.ts).
 *
 * Keys: ↑/↓ (or k/j) move · → expand · ← collapse (again: jump to parent) ·
 * Space toggle · Enter resume · Esc clear-filter-then-cancel · type to filter.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatResumeRow } from "../resume-filtered.js";
import { type SessionTreeNode, sanitizeRowText, searchRows, type TreeRow, toggleExpanded, visibleRows } from "../session-tree.js";

/** Minimal theme surface (real theme in prod, identity fns in tests). */
export interface ResumeTreeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface ResumeTreePickerOpts {
  roots: SessionTreeNode[];
  currentFile?: string;
  /** Max rows per page; the list windows with a scroll indicator. */
  maxVisible?: number;
}

const BACKSPACE = new Set(["\x7f", "\b"]);

export function createResumeTreePicker(
  opts: ResumeTreePickerOpts,
  theme: ResumeTreeTheme,
  done: (path: string | undefined) => void,
) {
  const maxVisible = opts.maxVisible ?? 12;
  let expanded = new Set<string>();
  let selected = 0;
  let filter = "";

  const rows = (): TreeRow[] =>
    filter.trim() ? searchRows(opts.roots, filter) : visibleRows(opts.roots, expanded);

  const clamp = (rs: TreeRow[]) => {
    selected = rs.length === 0 ? 0 : Math.max(0, Math.min(selected, rs.length - 1));
  };

  const label = (row: TreeRow): string => {
    const indent = "  ".repeat(row.depth);
    const marker = row.isParent ? (row.expanded ? "▼ " : "▶ ") : "· ";
    const badge = row.collapsedCount > 0
      ? ` · ${row.collapsedCount} child session${row.collapsedCount === 1 ? "" : "s"} (→ to expand)`
      : "";
    const scope = row.externalScope ? ` · ${row.externalScope} scope` : "";
    return `${indent}${marker}${formatResumeRow(row.session, Date.now(), opts.currentFile)}${badge}${scope}`;
  };

  /** Window start keeping the selection visible. Pure part, tested via render. */
  const windowStart = (rs: TreeRow[]): number => {
    if (rs.length <= maxVisible) return 0;
    const maxStart = rs.length - maxVisible;
    // Bias: keep one line of lookahead below the selection when possible.
    return Math.max(0, Math.min(maxStart, selected - maxVisible + 2));
  };

  const selectParent = (rs: TreeRow[]) => {
    const depth = rs[selected]?.depth ?? 0;
    for (let i = selected - 1; i >= 0; i--) {
      if (rs[i].depth < depth) {
        selected = i;
        return;
      }
    }
  };

  return {
    render(width: number): string[] {
      const rs = rows();
      clamp(rs);
      const lines = [
        theme.bold(`Resume session — ${rs.length} shown (collapsed by default)`),
        "",
      ];
      if (rs.length === 0) {
        lines.push(theme.fg("dim", filter ? `  No matches for "${filter}".` : "  No sessions."));
      } else {
        const start = windowStart(rs);
        const page = rs.slice(start, start + maxVisible);
        if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
        page.forEach((row, i) => {
          const cursor = start + i === selected ? theme.fg("accent", "› ") : "  ";
          const text = label(row);
          lines.push(cursor + (row.dimmed ? theme.fg("dim", text) : text));
        });
        const below = rs.length - start - page.length;
        if (below > 0) lines.push(theme.fg("dim", `  ↓ ${below} more`));
        lines.push(theme.fg("dim", `  (${selected + 1}/${rs.length})`));
      }
      if (filter) lines.push(theme.fg("dim", `  Filter: ${sanitizeRowText(filter, 40)}`));
      lines.push(
        theme.fg("dim", "  ↑↓ navigate · → expand · ← collapse · Space toggle · Enter resume · Esc clear-filter/cancel · type to filter"),
      );
      return lines.map(line => truncateToWidth(line, Math.max(20, width), "…"));
    },

    invalidate() {},

    handleInput(data: string) {
      const rs = rows();
      clamp(rs);
      // j/k navigate only when no filter is active; while filtering every
      // printable char (j and k included) extends the query. Arrows always
      // navigate — same split core's own selector uses (k/j nav there too).
      if (matchesKey(data, "up") || (!filter && data === "k")) {
        selected = Math.max(0, selected - 1);
      } else if (matchesKey(data, "down") || (!filter && data === "j")) {
        selected = Math.min(Math.max(0, rs.length - 1), selected + 1);
      } else if (matchesKey(data, "right")) {
        const row = rs[selected];
        if (row?.isParent && !row.expanded) expanded = toggleExpanded(expanded, row.session.path);
      } else if (matchesKey(data, "left")) {
        const row = rs[selected];
        if (row?.isParent && row.expanded) expanded = toggleExpanded(expanded, row.session.path);
        else selectParent(rows());
      } else if (data === " " || matchesKey(data, "space")) {
        const row = rs[selected];
        if (row?.isParent) expanded = toggleExpanded(expanded, row.session.path);
      } else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
        const rs = rows();
        // Empty list (filter matched nothing): no-op — the "No matches"
        // line already says so, and resolving undefined would silently
        // cancel a picker the user is still narrowing.
        if (rs.length === 0) return;
        const row = rs[selected];
        // Group rows expand instead of resuming: the pseudo-path is shared by
        // all members, so there is nothing unambiguous to switch to.
        if (row?.isGroup) {
          expanded = toggleExpanded(expanded, row.session.path);
        } else {
          done(row?.session.path);
        }
        return;
      } else if (matchesKey(data, "ctrl+c")) {
        // Immediate way out regardless of filter state.
        done(undefined);
        return;
      } else if (matchesKey(data, "escape") || data === "\x1b") {
        // Cancel: matchesKey first (honors user-remapped Escape and whatever
        // raw form the terminal layer delivered — the viewer-proven pattern),
        // raw lone-Esc fallback, Ctrl+C as the universal way out (the TUI
        // hands Ctrl+C to the focused component deliberately).
        if (filter) filter = "";
        else done(undefined);
        return;
      } else if (BACKSPACE.has(data)) {
        filter = filter.slice(0, -1);
      } else if (data.length === 1 && data >= " " && data <= "~" && filter.length < 40) {
        filter += data;
      }
      clamp(rows());
    },
  };
}
