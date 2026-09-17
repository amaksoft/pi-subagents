/**
 * stall-tracking.test.ts — heartbeat + stall visibility for hung agents.
 *
 * Covers the pure helpers directly (trackToolActivity, touchActivity,
 * isStalled, describeStall) and the FleetView activity tail
 * (describeFleetActivity, formatActivityAge). Manager wiring (spawn init,
 * handler flow) is covered in agent-manager.test.ts; the point here is the
 * diagnosis semantics: a tool start with no end must be describable.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  describeStall,
  isStalled,
  touchActivity,
  trackToolActivity,
} from "../src/status-note.js";
import { describeFleetActivity, formatActivityAge } from "../src/ui/fleet-list.js";

function running(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    toolUses: 0,
    lastActivityAt: Date.now(),
    currentTool: undefined,
    stalledSince: undefined,
    ...overrides,
  } as any;
}

describe("trackToolActivity", () => {
  it("sets currentTool on start without bumping the use count", () => {
    const record = running();
    trackToolActivity(record, { type: "start", toolName: "bash" });
    expect(record.currentTool?.name).toBe("bash");
    expect(record.toolUses).toBe(0);
  });

  it("clears currentTool and bumps the use count on end", () => {
    const record = running({ currentTool: { name: "bash", startedAt: Date.now() } });
    trackToolActivity(record, { type: "end", toolName: "bash" });
    expect(record.currentTool).toBeUndefined();
    expect(record.toolUses).toBe(1);
  });

  it("refreshes the heartbeat and clears a flagged stall", () => {
    const before = Date.now() - 20 * 60_000;
    const record = running({ lastActivityAt: before, stalledSince: before });
    trackToolActivity(record, { type: "end", toolName: "read" });
    expect(record.lastActivityAt).toBeGreaterThan(before);
    expect(record.stalledSince).toBeUndefined();
  });
});

describe("touchActivity", () => {
  it("refreshes the heartbeat and clears a flagged stall", () => {
    const before = Date.now() - 20 * 60_000;
    const record = running({ lastActivityAt: before, stalledSince: before });
    touchActivity(record);
    expect(record.lastActivityAt).toBeGreaterThan(before);
    expect(record.stalledSince).toBeUndefined();
  });
});

describe("isStalled", () => {
  it("is false for a freshly active agent", () => {
    expect(isStalled(running())).toBe(false);
  });

  it("is true past the threshold", () => {
    const record = running({ lastActivityAt: Date.now() - DEFAULT_STALL_THRESHOLD_MS - 1000 });
    expect(isStalled(record)).toBe(true);
  });

  it("is never true for terminal records, however old the heartbeat", () => {
    const record = running({ status: "completed", lastActivityAt: 0 });
    expect(isStalled(record)).toBe(false);
  });

  it("honors an explicit threshold", () => {
    const record = running({ lastActivityAt: Date.now() - 5000 });
    expect(isStalled(record, Date.now(), 60_000)).toBe(false);
    expect(isStalled(record, Date.now(), 1000)).toBe(true);
  });
});

describe("describeStall", () => {
  it("names the wedged tool and the silence", () => {
    const record = running({
      lastActivityAt: Date.now() - 22 * 60_000,
      currentTool: { name: "bash", startedAt: Date.now() - 22 * 60_000 },
    });
    expect(describeStall(record)).toBe("stalled 22m in bash");
  });

  it("calls out idleness when no tool is running", () => {
    const record = running({ lastActivityAt: Date.now() - 11 * 60_000 });
    expect(describeStall(record)).toBe("stalled 11m, idle (no tool running)");
  });

  it("is undefined for live and terminal agents", () => {
    expect(describeStall(running())).toBeUndefined();
    expect(describeStall(running({ status: "completed", lastActivityAt: 0 }))).toBeUndefined();
  });
});

describe("formatActivityAge", () => {
  it("shows seconds under a minute, minutes above", () => {
    expect(formatActivityAge(3000)).toBe("3s");
    expect(formatActivityAge(180_000)).toBe("3m");
  });
});

describe("describeFleetActivity", () => {
  it("shows the current tool and its age for running agents", () => {
    const record = running({ currentTool: { name: "bash", startedAt: Date.now() - 180_000 } });
    expect(describeFleetActivity(record)).toBe("▸ bash 3m");
  });

  it("prefers the stall diagnosis when silent past threshold", () => {
    const record = running({
      lastActivityAt: Date.now() - 22 * 60_000,
      currentTool: { name: "bash", startedAt: Date.now() - 22 * 60_000 },
      stalledSince: Date.now() - 60_000,
    });
    expect(describeFleetActivity(record)).toBe("stalled 22m in bash");
  });

  it("is undefined for idle-but-live and finished agents", () => {
    expect(describeFleetActivity(running())).toBeUndefined();
    expect(
      describeFleetActivity(running({ status: "completed", lastActivityAt: 0 })),
    ).toBeUndefined();
  });
});

describe("pushLiveOutput", () => {
  it("keeps the last lines within caps", async () => {
    const { pushLiveOutput, LIVE_OUTPUT_LINES, LIVE_OUTPUT_CHARS } = await import("../src/status-note.js");
    const record = {} as any;
    for (let i = 0; i < 30; i++) pushLiveOutput(record, `line ${i}`);
    const lines = record.liveOutput.split("\n");
    expect(lines.length).toBeLessThanOrEqual(LIVE_OUTPUT_LINES);
    expect(lines[lines.length - 1]).toBe("line 29");
    expect(record.liveOutput.length).toBeLessThanOrEqual(LIVE_OUTPUT_CHARS);
    pushLiveOutput(record, "");
    expect(record.liveOutput.split("\n").length).toBeLessThanOrEqual(LIVE_OUTPUT_LINES);
  });

  it("clears the tail on tool end via trackToolActivity", async () => {
    const { pushLiveOutput, trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0 } as any;
    pushLiveOutput(record, "building…");
    trackToolActivity(record, { type: "start", toolName: "bash" });
    expect(record.liveOutput).toContain("building…");
    trackToolActivity(record, { type: "end", toolName: "bash" });
    expect(record.liveOutput).toBeUndefined();
    expect(record.currentTool).toBeUndefined();
  });
});

describe("describeToolActivity", () => {
  it("distinguishes working from silent tool runs", async () => {
    const { describeToolActivity } = await import("../src/status-note.js");
    const now = Date.now();
    expect(describeToolActivity({} as any, now)).toBeUndefined();
    expect(
      describeToolActivity(
        { currentTool: { name: "bash", startedAt: now - 22 * 60_000 }, lastOutputAt: now - 30_000 } as any,
        now,
      ),
    ).toBe("bash for 22m, output 30s ago");
    expect(
      describeToolActivity({ currentTool: { name: "bash", startedAt: now - 22 * 60_000 } } as any, now),
    ).toBe("bash for 22m, silent throughout");
    // Stale output predating the tool start does not count.
    expect(
      describeToolActivity(
        { currentTool: { name: "bash", startedAt: now - 5 * 60_000 }, lastOutputAt: now - 30 * 60_000 } as any,
        now,
      ),
    ).toBe("bash for 5m, silent throughout");
  });
});

describe("parallel tool tracking", () => {
  it("an unrelated end does not wipe the running tool or its tail", async () => {
    const { pushLiveOutput, trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0 } as any;
    trackToolActivity(record, { type: "start", toolName: "bash" });
    pushLiveOutput(record, "building…");
    trackToolActivity(record, { type: "start", toolName: "read" });
    // Latest wins the slot…
    expect(record.currentTool?.name).toBe("read");
    // …but ending the earlier call must not clear the live one or its tail.
    // (Same-name parallel calls share the slot — documented residual.)
    trackToolActivity(record, { type: "start", toolName: "bash" });
    pushLiveOutput(record, "still building…");
    trackToolActivity(record, { type: "end", toolName: "read" });
    expect(record.currentTool?.name).toBe("bash");
    expect(record.liveOutput).toContain("still building…");
    expect(record.toolUses).toBe(1);
    trackToolActivity(record, { type: "end", toolName: "bash" });
    expect(record.currentTool).toBeUndefined();
    expect(record.liveOutput).toBeUndefined();
    expect(record.toolUses).toBe(2);
  });
});

describe("thinking activity", () => {
  it("thinking deltas refresh the heartbeat without fabricating output", async () => {
    const { touchActivity } = await import("../src/status-note.js");
    void touchActivity;
    const record = { lastActivityAt: 0, lastOutputAt: undefined, reasoningSince: undefined } as any;
    // Simulate the manager's onThinkingActivity wiring.
    const onThinking = (phase: string) => {
      if (phase === "end") record.reasoningSince = undefined;
      else if (record.reasoningSince === undefined) record.reasoningSince = Date.now();
      record.lastActivityAt = Date.now();
      record.stalledSince = undefined;
    };
    onThinking("delta");
    expect(record.lastActivityAt).toBeGreaterThan(0);
    expect(record.lastOutputAt).toBeUndefined();
    expect(record.reasoningSince).toBeDefined();
    const start = record.reasoningSince;
    onThinking("delta");
    expect(record.reasoningSince).toBe(start); // stretch start preserved
    onThinking("end");
    expect(record.reasoningSince).toBeUndefined();
  });

  it("describeToolActivity reads reasoning stretches", async () => {
    const { describeToolActivity } = await import("../src/status-note.js");
    const now = Date.now();
    expect(
      describeToolActivity({ reasoningSince: now - 14 * 60_000 } as any, now),
    ).toBe("reasoning for 14m");
    expect(describeToolActivity({} as any, now)).toBeUndefined();
  });

  it("tool start ends reasoning; text ends reasoning (via trackToolActivity)", async () => {
    const { trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0, reasoningSince: Date.now() } as any;
    trackToolActivity(record, { type: "start", toolName: "bash" });
    expect(record.reasoningSince).toBeUndefined();
    expect(record.currentTool?.name).toBe("bash");
  });
});

describe("callId-matched tool tracking", () => {
  it("parallel same-tool calls resolve independently", async () => {
    const { trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0 } as any;
    trackToolActivity(record, { type: "start", toolName: "bash", callId: "c1" });
    record.liveOutput = "building…";
    trackToolActivity(record, { type: "start", toolName: "bash", callId: "c2" });
    expect(record.currentTool).toMatchObject({ name: "bash", callId: "c2" });
    // First call ends: sibling survives with slot and tail intact.
    trackToolActivity(record, { type: "end", toolName: "bash", callId: "c1" });
    expect(record.currentTool).toMatchObject({ name: "bash", callId: "c2" });
    expect(record.liveOutput).toContain("building…");
    expect(record.toolUses).toBe(1);
    // Second call ends: slot and tail clear.
    trackToolActivity(record, { type: "end", toolName: "bash", callId: "c2" });
    expect(record.currentTool).toBeUndefined();
    expect(record.liveOutput).toBeUndefined();
    expect(record.toolUses).toBe(2);
  });

  it("falls back to name matching without callIds (legacy/stub events)", async () => {
    const { trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0 } as any;
    trackToolActivity(record, { type: "start", toolName: "bash" });
    trackToolActivity(record, { type: "end", toolName: "bash" });
    expect(record.currentTool).toBeUndefined();
    expect(record.toolUses).toBe(1);
  });

  it("an unrelated end never clears the tracked call", async () => {
    const { trackToolActivity } = await import("../src/status-note.js");
    const record = { toolUses: 0, lastActivityAt: 0 } as any;
    trackToolActivity(record, { type: "start", toolName: "bash", callId: "c1" });
    trackToolActivity(record, { type: "end", toolName: "read", callId: "c9" });
    expect(record.currentTool).toMatchObject({ name: "bash", callId: "c1" });
    expect(record.toolUses).toBe(1);
  });
});

describe("threshold-threading", () => {
  it("display paths agree with a custom enforcement threshold", async () => {
    const { describeStall, isStalled } = await import("../src/status-note.js");
    const { describeFleetActivity } = await import("../src/ui/fleet-list.js");
    const { countStalledAgents } = await import("../src/ui/workflow-card.js");
    const now = Date.now();
    const record = {
      status: "running",
      lastActivityAt: now - 6 * 60_000,
      currentTool: { name: "bash", startedAt: now - 6 * 60_000 },
    } as any;
    // Default 10min: silent 6min is live everywhere…
    expect(isStalled(record, now)).toBe(false);
    expect(describeStall(record, now)).toBeUndefined();
    expect(describeFleetActivity(record, now)).toContain("▸ bash");
    // …custom 5min: stalled everywhere, identically.
    expect(isStalled(record, now, 5 * 60_000)).toBe(true);
    expect(describeStall(record, now, 5 * 60_000)).toBe("stalled 6m in bash");
    expect(describeFleetActivity(record, now, 5 * 60_000)).toBe("stalled 6m in bash");
    const entries = [{ type: "workflow_agent", index: 0, recordId: "r1" }] as any;
    const getRecord = () => record;
    expect(countStalledAgents(entries, getRecord, now)).toBe(0);
    expect(countStalledAgents(entries, getRecord, now, 5 * 60_000)).toBe(1);
  });
});
