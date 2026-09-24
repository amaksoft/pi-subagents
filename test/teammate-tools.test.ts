/**
 * teammate-tools.test.ts — session-team mail.
 *
 * Covers the pure pieces directly (ref resolution, roster, tool execute
 * against a fake manager) — delivery semantics (inbox bound, envelope,
 * refusals) are covered in agent-manager.test.ts against the real manager.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTeammateTools,
  resolveTeammateRef,
  TEAMMATE_INBOX_CAP,
  teammateRoster,
} from "../src/teammate-tools.js";

const rec = (overrides: Record<string, unknown> = {}) => ({
  id: "a1",
  handle: "scout",
  alias: undefined,
  ...overrides,
});

describe("resolveTeammateRef", () => {
  const team = [rec({ id: "a1", handle: "Scout" }), rec({ id: "a2", handle: undefined, alias: "builder" })];

  it("matches handle case-insensitively, then alias, then id", () => {
    expect(resolveTeammateRef(team, "scout")?.id).toBe("a1");
    expect(resolveTeammateRef(team, "BUILDER")?.id).toBe("a2");
    expect(resolveTeammateRef(team, "a1")?.id).toBe("a1");
    expect(resolveTeammateRef(team, "nobody")).toBeUndefined();
  });
});

describe("teammateRoster", () => {
  it("names the crew, or admits emptiness", () => {
    expect(teammateRoster([rec()])).toBe("scout");
    expect(teammateRoster([])).toContain("no other teammates");
  });
});

describe("message_teammate tool", () => {
  function toolWith(deliver: (from: string, to: string, text: string) => { ok: boolean; reason?: string }, selfId = "sender") {
    const delivered: { from: string; to: string; text: string }[] = [];
    const manager = {
      deliverTeammateMessage: vi.fn((from: string, to: string, text: string) => {
        delivered.push({ from, to, text });
        return deliver(from, to, text);
      }),
      listTeammates: vi.fn(() => [rec(), rec({ id: "a2", handle: "builder" })]),
    };
    const [tool] = createTeammateTools({ manager, senderLabel: "@sender", selfId });
    return { tool, manager, delivered };
  }

  const textOf = (r: any): string => r.content[0].text;

  it("delivers with the sender's label and confirms", async () => {
    const { tool, delivered } = toolWith(() => ({ ok: true }));
    const out = textOf(await (tool.execute as any)("c", { target: "builder", message: "found it" }));
    expect(out).toContain("delivered to builder");
    expect(delivered).toEqual([{ from: "@sender", to: "a2", text: "found it" }]);
  });

  it("names the roster on a miss", async () => {
    const { tool } = toolWith(() => ({ ok: true }));
    const out = textOf(await (tool.execute as any)("c", { target: "ghost", message: "hi" }));
    expect(out).toContain("Teammate not found");
    expect(out).toContain("scout");
    expect(out).toContain("builder");
  });

  it("refuses to message yourself", async () => {
    const { tool, delivered } = toolWith(() => ({ ok: true }), "a1");
    const out = textOf(await (tool.execute as any)("c", { target: "scout", message: "hi me" }));
    expect(out).toContain("yourself");
    expect(delivered).toHaveLength(0);
  });

  it("surfaces delivery refusals", async () => {
    const { tool } = toolWith(() => ({ ok: false, reason: "Agent is not running (status: completed)." }));
    const out = textOf(await (tool.execute as any)("c", { target: "builder", message: "hi" }));
    expect(out).toContain("not running");
  });

  it("caps the inbox, oldest drops first", () => {
    expect(TEAMMATE_INBOX_CAP).toBe(20);
  });
});
