/**
 * session-tree.test.ts — collapsible resume tree model + picker keys.
 *
 * Pure model (build/visible/toggle/search) tested directly; the overlay
 * component is driven with raw key sequences like the viewer keybinding
 * tests (UP = \x1b[A etc.), with an identity theme.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResumeSession } from "../src/resume-filtered.js";
import {
  buildSessionTree,
  searchRows,
  toggleExpanded,
  visibleRows,
} from "../src/session-tree.js";
import { createResumeTreePicker } from "../src/ui/resume-tree-picker.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";

function session(overrides: Partial<ResumeSession> = {}): ResumeSession {
  return {
    path: `/sessions/${Math.random().toString(36).slice(2)}.jsonl`,
    name: undefined,
    parentSessionPath: undefined,
    messageCount: 5,
    modified: new Date(),
    firstMessage: "do things",
    ...overrides,
  };
}

const theme = {
  fg: (_c: string, text: string) => text,
  bold: (text: string) => text,
};

describe("buildSessionTree", () => {
  it("threads children under parents, orphans become roots, newest first", () => {
    const parent = session({ path: "/s/p.jsonl", modified: new Date(1000) });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl", modified: new Date(2000) });
    const orphan = session({ path: "/s/o.jsonl", parentSessionPath: "/s/gone.jsonl", modified: new Date(3000) });
    const roots = buildSessionTree([child, orphan, parent]);
    expect(roots.map(r => r.session.path)).toEqual(["/s/o.jsonl", "/s/p.jsonl"]);
    expect(roots[1].children.map(c => c.session.path)).toEqual(["/s/c.jsonl"]);
    expect(roots[1].descendantCount).toBe(1);
  });

  it("counts nested descendants", () => {
    const a = session({ path: "/s/a.jsonl" });
    const b = session({ path: "/s/b.jsonl", parentSessionPath: "/s/a.jsonl" });
    const c = session({ path: "/s/c.jsonl", parentSessionPath: "/s/b.jsonl" });
    const roots = buildSessionTree([a, b, c]);
    expect(roots[0].descendantCount).toBe(2);
    expect(roots[0].children[0].descendantCount).toBe(1);
  });
});

describe("visibleRows", () => {
  it("shows roots only by default (collapsed)", () => {
    const parent = session({ path: "/s/p.jsonl", name: "real work" });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl" });
    const roots = buildSessionTree([parent, child]);
    const rows = visibleRows(roots, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].isParent).toBe(true);
    expect(rows[0].expanded).toBe(false);
    expect(rows[0].collapsedCount).toBe(1);
  });

  it("reveals children once expanded", () => {
    const parent = session({ path: "/s/p.jsonl" });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl" });
    const roots = buildSessionTree([parent, child]);
    const rows = visibleRows(roots, new Set(["/s/p.jsonl"]));
    expect(rows.map(r => [r.session.path, r.depth])).toEqual([
      ["/s/p.jsonl", 0],
      ["/s/c.jsonl", 1],
    ]);
  });
});

describe("toggleExpanded", () => {
  it("adds and removes paths immutably", () => {
    const before = new Set<string>();
    const after = toggleExpanded(before, "/s/p.jsonl");
    expect(after.has("/s/p.jsonl")).toBe(true);
    expect(before.has("/s/p.jsonl")).toBe(false);
    expect(toggleExpanded(after, "/s/p.jsonl").has("/s/p.jsonl")).toBe(false);
  });
});

describe("searchRows", () => {
  it("returns hits with their ancestor chain, ancestors dimmed", () => {
    const parent = session({ path: "/s/p.jsonl", name: "real work" });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl", firstMessage: "verify token refresh" });
    const roots = buildSessionTree([parent, child]);
    const rows = searchRows(roots, "token");
    expect(rows.map(r => r.session.path)).toEqual(["/s/p.jsonl", "/s/c.jsonl"]);
    expect(rows[0].dimmed).toBe(true);
    expect(rows[1].dimmed).not.toBe(true);
  });

  it("finds nothing cleanly", () => {
    const roots = buildSessionTree([session({ firstMessage: "hello" })]);
    expect(searchRows(roots, "zzz")).toEqual([]);
  });
});

function picker(roots: ReturnType<typeof buildSessionTree>) {
  const done = vi.fn();
  const ui = createResumeTreePicker({ roots }, theme, done);
  return { ui, done };
}

describe("resume tree picker", () => {
  it("loads collapsed with a child-count badge, expands on →", () => {
    const parent = session({ path: "/s/p.jsonl", name: "real work" });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl" });
    const { ui } = picker(buildSessionTree([parent, child]));
    let lines = ui.render(100).join("\n");
    expect(lines).toContain("1 child session (→ to expand)");
    expect(lines).not.toContain("do things");

    ui.handleInput(RIGHT);
    lines = ui.render(100).join("\n");
    expect(lines).toContain("do things");
    expect(lines).not.toContain("child session (→ to expand)");
  });

  it("resumes the selected row on Enter, cancels on Esc", () => {
    const a = session({ path: "/s/a.jsonl", name: "alpha" });
    const b = session({ path: "/s/b.jsonl", name: "beta" });
    const { ui, done } = picker(buildSessionTree([a, b]));
    ui.handleInput(DOWN);
    ui.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith("/s/b.jsonl");

    const second = picker(buildSessionTree([a]));
    second.ui.handleInput(ESC);
    expect(second.done).toHaveBeenCalledWith(undefined);
  });

  it("← on a collapsed child jumps to its parent", () => {
    const parent = session({ path: "/s/p.jsonl", name: "p" });
    const child = session({ path: "/s/c.jsonl", parentSessionPath: "/s/p.jsonl", name: "c" });
    const { ui, done } = picker(buildSessionTree([parent, child]));
    ui.handleInput(RIGHT); // expand
    ui.handleInput(DOWN); // onto child
    ui.handleInput(LEFT); // child not expanded → jump to parent
    ui.handleInput(ENTER);
    expect(done).toHaveBeenCalledWith("/s/p.jsonl");
  });

  it("typing filters, Esc clears first then cancels", () => {
    const a = session({ path: "/s/a.jsonl", name: "alpha work" });
    const b = session({ path: "/s/b.jsonl", name: "beta work" });
    const { ui, done } = picker(buildSessionTree([a, b]));
    for (const ch of "beta") ui.handleInput(ch);
    let lines = ui.render(100).join("\n");
    expect(lines).toContain("beta work");
    expect(lines).not.toContain("alpha work");

    ui.handleInput(ESC); // clears filter…
    lines = ui.render(100).join("\n");
    expect(lines).toContain("alpha work");
    expect(done).not.toHaveBeenCalled();
    ui.handleInput(ESC); // …then cancels
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("windows long lists with a scroll indicator", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      session({ path: `/s/${i}.jsonl`, name: `work ${i}`, modified: new Date(i) }));
    const done = vi.fn();
    const ui = createResumeTreePicker({ roots: buildSessionTree(many), maxVisible: 10 }, theme, done);
    const lines = ui.render(100).join("\n");
    expect(lines).toContain("↓ 20 more");
    expect(lines).toContain("(1/30)");
    // Walk to the bottom: the window must follow the selection.
    for (let i = 0; i < 29; i++) ui.handleInput(DOWN);
    const bottom = ui.render(100).join("\n");
    expect(bottom).toContain("(30/30)");
    expect(bottom).toContain("↑ 20 more");
  });

  it("UP/DOWN never leave the list (regression: unw windowed select)", () => {
    const { ui } = picker(buildSessionTree([session({ path: "/s/a.jsonl" })]));
    ui.handleInput(UP);
    ui.handleInput(DOWN);
    ui.handleInput(DOWN);
    const lines = ui.render(100).join("\n");
    expect(lines).toContain("(1/1)");
  });
});
