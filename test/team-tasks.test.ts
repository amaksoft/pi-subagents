/**
 * team-tasks.test.ts — session-team shared task list.
 *
 * Store semantics directly (claim rules, dependency guards, persistence
 * round-trip through a tmp dir) plus the shared action runner both tool
 * closures use. Wiring (who gets the tool) is covered in
 * agent-runner.test.ts alongside the mailbox.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTeamTasksAction, TEAM_LEAD_LABEL, TeamTaskStore } from "../src/team-tasks.js";

const textOf = (r: any): string => r.content[0].text;

describe("TeamTaskStore", () => {
  it("creates sequential ids and lists in creation order", () => {
    const store = new TeamTaskStore();
    const a = store.create({ title: "first" }, "main session");
    const b = store.create({ title: "second" }, "@scout");
    expect(a.id).toBe("t1");
    expect(b.id).toBe("t2");
    expect(a.createdBy).toBe("main session");
    expect(store.list().map(t => t.id)).toEqual(["t1", "t2"]);
  });

  it("free claims, negotiated steals", () => {
    const store = new TeamTaskStore();
    store.create({ title: "work" }, "main session");
    // Unowned: anyone claims.
    expect(store.update("t1", { owner: "@scout" }, "@scout").owner).toBe("@scout");
    // Owned by another peer: refuses with the negotiation pointer.
    expect(() => store.update("t1", { owner: "@builder" }, "@builder")).toThrow(/claimed by @scout.*message_teammate/);
    // Same owner re-asserts fine; release works.
    expect(store.update("t1", { owner: "@scout" }, "@scout").owner).toBe("@scout");
    expect(store.update("t1", { owner: null }, "@scout").owner).toBeUndefined();
  });

  it("the lead may reassign", () => {
    const store = new TeamTaskStore();
    store.create({ title: "work", owner: "@scout" }, "main session");
    expect(store.update("t1", { owner: "@builder" }, TEAM_LEAD_LABEL).owner).toBe("@builder");
  });

  it("validates dependencies and guards deletes", () => {
    const store = new TeamTaskStore();
    expect(() => store.create({ title: "x", dependsOn: ["t99"] }, "m")).toThrow(/Unknown dependency/);
    store.create({ title: "base" }, "m");
    store.create({ title: "top", dependsOn: ["t1"] }, "m");
    expect(() => store.remove("t1")).toThrow(/dependency of t2/);
    expect(() => store.update("t2", { dependsOn: ["t2"] }, "m")).toThrow(/itself/);
    store.remove("t2");
    store.remove("t1");
    expect(store.list()).toHaveLength(0);
  });

  it("round-trips through the snapshot file", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-tasks-"));
    try {
      const a = new TeamTaskStore(dir, "sess1");
      a.create({ title: "persist me", details: "yes" }, "@scout");
      a.update("t1", { status: "in-progress", owner: "@scout" }, "@scout");
      const snap = JSON.parse(readFileSync(join(dir, ".pi", "subagent-teams", "sess1.json"), "utf-8"));
      expect(snap.tasks).toHaveLength(1);
      const b = new TeamTaskStore(dir, "sess1");
      expect(b.get("t1")).toMatchObject({ title: "persist me", status: "in-progress", owner: "@scout" });
      // Counter survives: next id continues, no collision.
      expect(b.create({ title: "next" }, "m").id).toBe("t2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory-only without a session id, corrupt snapshot reads empty", () => {
    const mem = new TeamTaskStore();
    mem.create({ title: "ephemeral" }, "m");
    expect(mem.list()).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), "team-tasks-"));
    try {
      mkdirSync(join(dir, ".pi", "subagent-teams"), { recursive: true });
      writeFileSync(join(dir, ".pi", "subagent-teams", "bad.json"), "{not json");
      const reloaded = new TeamTaskStore(dir, "bad");
      expect(reloaded.list()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runTeamTasksAction", () => {
  it("drives the full loop both closures share", () => {
    const store = new TeamTaskStore();
    expect(textOf(runTeamTasksAction(store, "main session", { action: "create", title: "a" }))).toContain("t1");
    expect(textOf(runTeamTasksAction(store, "@scout", { action: "update", id: "t1", owner: "@scout", status: "in-progress" }))).toContain("@scout");
    expect(textOf(runTeamTasksAction(store, "@builder", { action: "update", id: "t1", owner: "@builder" }))).toContain("claimed by @scout");
    const listed = textOf(runTeamTasksAction(store, "main session", { action: "list" }));
    expect(listed).toContain("t1 [in-progress]");
    expect(textOf(runTeamTasksAction(store, "main session", { action: "create" } as any)).toLowerCase()).toContain("title");
  });
});
