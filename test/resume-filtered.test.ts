/**
 * resume-filtered.test.ts — /resume-filtered hides spawned sessions.
 *
 * Drives runResumeFiltered with fake collaborators: no pi needed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  formatResumeAge,
  formatResumeRow,
  isSubagentSession,
  type ResumeFilteredDeps,
  type ResumeSession,
  runResumeFiltered,
} from "../src/resume-filtered.js";

function session(overrides: Partial<ResumeSession> = {}): ResumeSession {
  return {
    path: "/sessions/a.jsonl",
    name: undefined,
    parentSessionPath: undefined,
    messageCount: 12,
    modified: new Date(Date.now() - 5 * 60_000),
    firstMessage: "fix the login bug",
    ...overrides,
  };
}

function deps(overrides: Partial<ResumeFilteredDeps> = {}): ResumeFilteredDeps & {
  switched: string[];
  notices: string[];
} {
  const d = {
    switched: [] as string[],
    notices: [] as string[],
    listCurrent: async () => [] as ResumeSession[],
    listAll: async () => [] as ResumeSession[],
    select: async () => undefined as string | undefined,
    notify: (message: string) => {
      d.notices.push(message);
    },
    switchSession: async (path: string) => {
      d.switched.push(path);
      return { cancelled: false };
    },
    ...overrides,
  };
  return d;
}

describe("isSubagentSession", () => {
  it("flags sessions carrying a parent path, nothing else", () => {
    expect(isSubagentSession(session())).toBe(false);
    expect(isSubagentSession(session({ parentSessionPath: "/sessions/parent.jsonl" }))).toBe(true);
  });
});

describe("formatResumeAge", () => {
  it("compacts ages", () => {
    expect(formatResumeAge(10_000)).toBe("just now");
    expect(formatResumeAge(5 * 60_000)).toBe("5m");
    expect(formatResumeAge(3 * 3600_000)).toBe("3h");
    expect(formatResumeAge(4 * 86400_000)).toBe("4d");
  });
});

describe("formatResumeRow", () => {
  it("prefers the name, falls back to the first message", () => {
    expect(formatResumeRow(session({ name: "auth work" }))).toContain("auth work");
    expect(formatResumeRow(session({ name: undefined }))).toContain("fix the login bug");
  });

  it("marks the current session", () => {
    expect(formatResumeRow(session(), Date.now(), "/sessions/a.jsonl")).toContain("current");
    expect(formatResumeRow(session(), Date.now(), "/sessions/other.jsonl")).not.toContain("current");
  });
});

describe("runResumeFiltered", () => {
  it("hides subagent sessions and switches to the pick", async () => {
    const parent = session({ path: "/sessions/parent.jsonl", name: "real work" });
    const child = session({
      path: "/sessions/child.jsonl",
      name: "general-purpose#a1b2c3d4",
      parentSessionPath: "/sessions/parent.jsonl",
    });
    const d = deps({
      listCurrent: async () => [parent, child],
      select: async (_title, options) => options[0],
    });
    await runResumeFiltered(d, "");
    expect(d.switched).toEqual(["/sessions/parent.jsonl"]);
  });

  it("notifies instead of prompting when only subagents exist", async () => {
    const d = deps({
      listCurrent: async () => [session({ parentSessionPath: "/sessions/p.jsonl" })],
      select: vi.fn(),
    });
    await runResumeFiltered(d, "");
    expect(d.switched).toEqual([]);
    expect(d.select).not.toHaveBeenCalled();
    expect(d.notices.join(" ")).toContain("hid 1 subagent session");
  });

  it("uses the all-scope loader for the `all` arg", async () => {
    const listCurrent = vi.fn(async () => [] as ResumeSession[]);
    const listAll = vi.fn(async () => [session()]);
    const d = deps({ listCurrent, listAll, select: async () => undefined });
    await runResumeFiltered(d, "all");
    expect(listAll).toHaveBeenCalled();
    expect(listCurrent).not.toHaveBeenCalled();
  });

  it("does nothing when the user escapes, and reports list failures", async () => {
    const d = deps({ listCurrent: async () => [session()], select: async () => undefined });
    await runResumeFiltered(d, "");
    expect(d.switched).toEqual([]);

    const failing = deps({
      listCurrent: async () => {
        throw new Error("disk gone");
      },
    });
    await runResumeFiltered(failing, "");
    expect(failing.notices.join(" ")).toContain("Could not list sessions");
  });
});

describe("runResumeFiltered tree mode", () => {
  it("passes the full tree (subagents included) and switches to the pick", async () => {
    const { buildSessionTree } = await import("../src/session-tree.js");
    const parent = session({ path: "/sessions/parent.jsonl", name: "real work" });
    const child = session({
      path: "/sessions/child.jsonl",
      parentSessionPath: "/sessions/parent.jsonl",
    });
    let seenRoots: unknown[] = [];
    const d = deps({
      listCurrent: async () => [parent, child],
      pickFromTree: async (roots) => {
        seenRoots = roots;
        return "/sessions/child.jsonl";
      },
    });
    await runResumeFiltered(d, "");
    // Tree keeps the child (collapsed by default in the UI) instead of hiding.
    expect((seenRoots as { session: { path: string } }[])[0].session.path).toBe(
      "/sessions/parent.jsonl",
    );
    expect(d.switched).toEqual(["/sessions/child.jsonl"]);
    expect(buildSessionTree).toBeDefined();
  });

  it("does nothing when the tree picker is cancelled", async () => {
    const d = deps({
      listCurrent: async () => [session()],
      pickFromTree: async () => undefined,
      select: vi.fn(),
    });
    await runResumeFiltered(d, "");
    expect(d.switched).toEqual([]);
    expect(d.select).not.toHaveBeenCalled();
  });
});
