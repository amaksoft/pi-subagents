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
