/**
 * control-status.test.ts — renderRunStatus against the wf_0435 incident.
 *
 * On 2026-09-23 a review workflow settled 39/40 agents and wedged on one
 * verify (#18, silent in a bash call for ~21h). The old status rendered the
 * raw append-only log — 199 rows, 160 of them stale "start" history — and the
 * judging session read the stale rows as live agents, reported the run
 * "alive", and re-checked 9 hours later to find it unchanged.
 *
 * These tests replay that shape (scaled to the same proportions) and pin the
 * contract: one row per agent, judge summary first, BARRIER HELD naming the
 * exact straggler and the exact next action.
 */
import { describe, expect, it } from "vitest";
import { renderAgentInspect, renderRunStatus } from "../src/workflow/control.js";
import type { WorkflowEntry } from "../src/workflow/progress.js";

const NOW = 1_790_244_971_459;
const HOUR = 3_600_000;

function startRow(index: number, label: string, at: number): WorkflowEntry {
  return {
    type: "workflow_agent",
    index,
    label,
    state: "start",
    agentId: `wf-agent-${index}`,
    queuedAt: at,
    startedAt: at,
    lastProgressAt: at,
  };
}

function doneRow(index: number, label: string, at: number): WorkflowEntry {
  return {
    type: "workflow_agent",
    index,
    label,
    state: "done",
    agentId: `wf-agent-${index}`,
    queuedAt: at - 5 * 60_000,
    startedAt: at - 5 * 60_000,
    lastProgressAt: at,
    resultPreview: '{"ok":true}',
  };
}

/** The incident shape: every agent re-emitted several times, 39 settled, #18 wedged. */
function incidentProgress(): WorkflowEntry[] {
  const rows: WorkflowEntry[] = [];
  const t0 = NOW - 21 * HOUR;
  for (let i = 0; i < 40; i++) {
    const label = i < 5 ? `review:${i}` : "verify";
    // Stale history every agent accumulates: queued, started, re-emitted.
    rows.push(startRow(i, label, t0 + i * 1000));
    rows.push(startRow(i, label, t0 + i * 1000 + 500));
    rows.push(startRow(i, label, t0 + i * 1000 + 900));
    if (i === 18) {
      // Still live, with a manager record — the wedge.
      rows.push({
        type: "workflow_agent",
        index: 18,
        label: "verify",
        state: "start",
        agentId: "wf-agent-18",
        recordId: "rec-18",
        queuedAt: t0,
        startedAt: t0,
        lastProgressAt: t0,
      });
    } else {
      rows.push(doneRow(i, label, t0 + (i + 10) * 60_000));
    }
  }
  return rows;
}

const wedgedRecord = {
  status: "running",
  lastActivityAt: NOW - 21 * HOUR,
  currentTool: { name: "bash" },
  snoozedUntil: undefined,
} as any;

describe("renderRunStatus (wf_0435 replay)", () => {
  it("renders one row per agent, not the raw history", () => {
    const out = renderRunStatus(
      { id: "wf_0435", status: "running", name: "review", progress: incidentProgress() },
      id => (id === "rec-18" ? wedgedRecord : undefined),
      10 * 60_000,
      NOW,
    );
    const rows = out.split("\n").filter(l => /^#\d+ /.test(l));
    expect(rows).toHaveLength(40);
    expect(rows.filter(l => /^#18 /.test(l))).toHaveLength(1);
  });

  it("leads with settled count, BARRIER HELD, and the exact next action", () => {
    const out = renderRunStatus(
      { id: "wf_0435", status: "running", name: "review", progress: incidentProgress() },
      id => (id === "rec-18" ? wedgedRecord : undefined),
      10 * 60_000,
      NOW,
    );
    const [head, advice] = out.split("\n");
    expect(head).toContain("39/40 agents settled");
    expect(head).toContain("BARRIER HELD");
    expect(head).toContain("#18");
    expect(advice).toContain("stop_agent #18");
  });

  it("names the stall on the straggler's own row", () => {
    const out = renderRunStatus(
      { id: "wf_0435", status: "running", name: "review", progress: incidentProgress() },
      id => (id === "rec-18" ? wedgedRecord : undefined),
      10 * 60_000,
      NOW,
    );
    const row = out.split("\n").find(l => /^#18 /.test(l));
    expect(row).toContain("stalled");
    expect(row).toContain("bash");
  });

  it("says all-settled plainly when nothing is open", () => {
    const progress = incidentProgress().filter(
      e => !(e.type === "workflow_agent" && e.index === 18),
    );
    progress.push(doneRow(18, "verify", NOW - HOUR));
    const out = renderRunStatus(
      { id: "wf_0435", status: "running", name: "review", progress },
      () => undefined,
      10 * 60_000,
      NOW,
    );
    expect(out.split("\n")[0]).toContain("40/40 agents settled");
    expect(out).not.toContain("BARRIER HELD");
  });
});

describe("renderAgentInspect (judge's brief)", () => {
  const wedgedEntry = {
    type: "workflow_agent",
    index: 18,
    label: "verify",
    state: "start",
    agentId: "wf-agent-18",
    recordId: "rec-18",
    queuedAt: NOW - 21 * HOUR,
    startedAt: NOW - 21 * HOUR,
    lastProgressAt: NOW - 21 * HOUR,
  } as any;

  it("lays out stall, tool elapsed, ages and tail for a wedged agent", () => {
    const record = {
      ...wedgedRecord,
      toolUses: 3,
      stalledSince: NOW - 20 * HOUR,
      liveOutput: "$ curl https://example.com/big.tar.gz\n",
    } as any;
    const out = renderAgentInspect(wedgedEntry, record, 10 * 60_000, NOW);
    expect(out).toContain("#18 verify");
    expect(out).toContain("stalled");
    expect(out).toContain("bash");
    expect(out).toContain("tool uses: 3");
    expect(out).toContain("curl");
  });

  it("says parked, not wedged, for a never-spawned agent", () => {
    const out = renderAgentInspect(
      { ...wedgedEntry, recordId: undefined, startedAt: undefined } as any,
      undefined,
      10 * 60_000,
      NOW,
    );
    expect(out).toContain("parked behind the run's concurrency limit");
    expect(out).not.toContain("stalled");
  });

  it("reports a settled agent from the journal alone", () => {
    const out = renderAgentInspect(
      { ...wedgedEntry, state: "done", resultPreview: '{"isReal":true}' } as any,
      undefined,
      10 * 60_000,
      NOW,
    );
    expect(out).toContain('{"isReal":true}');
  });
});

describe("stalledChildrenOf + stallCheckinKey (run-level check-in)", () => {
  const rec = (episodes: number) =>
    ({
      status: "running",
      lastActivityAt: NOW - 3 * HOUR,
      currentTool: { name: "bash", startedAt: NOW - 3 * HOUR },
      snoozedUntil: undefined,
      stallEpisodes: episodes,
    }) as any;

  const progress = (): WorkflowEntry[] => [
    { type: "workflow_agent", index: 0, label: "a", state: "start", agentId: "w0", recordId: "r0", queuedAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, lastProgressAt: NOW - 3 * HOUR },
    { type: "workflow_agent", index: 0, label: "a", state: "start", agentId: "w0", recordId: "r0", queuedAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, lastProgressAt: NOW - 3 * HOUR },
    { type: "workflow_agent", index: 1, label: "b", state: "done", agentId: "w1", resultPreview: "ok" },
  ];

  it("collapses history and joins live stalled records only", async () => {
    const { stalledChildrenOf } = await import("../src/workflow/control.js");
    const out = stalledChildrenOf(progress(), id => (id === "r0" ? rec(1) : undefined), 10 * 60_000, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 0, label: "a", episodes: 1 });
    expect(out[0].stall).toContain("bash");
  });

  it("key changes on new episodes, not on repeated sweeps", async () => {
    const { stalledChildrenOf, stallCheckinKey } = await import("../src/workflow/control.js");
    const get = (id: string) => (id === "r0" ? rec(1) : undefined);
    const k1 = stallCheckinKey(stalledChildrenOf(progress(), get, 10 * 60_000, NOW));
    const k2 = stallCheckinKey(stalledChildrenOf(progress(), get, 10 * 60_000, NOW + 60_000));
    expect(k1).toBe(k2);
    const k3 = stallCheckinKey(stalledChildrenOf(progress(), id => (id === "r0" ? rec(2) : undefined), 10 * 60_000, NOW));
    expect(k3).not.toBe(k1);
  });
});
