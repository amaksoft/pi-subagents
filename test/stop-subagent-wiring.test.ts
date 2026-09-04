/**
 * stop-subagent-wiring.test.ts — the model-reachable kill switch.
 *
 * Before `stop_subagent`, `manager.abort()` was only reachable from human UI
 * surfaces (`/agents` → viewer → `x` twice, FleetView, RPC). The orchestrator
 * itself had `steer_subagent` but no way to kill a stuck, looping, or
 * no-longer-needed child — steering a wedged agent just queues another message
 * it will never act on.
 *
 * These tests pin the tool contract: running → stopped with partial-output
 * guidance, finished → "nothing to stop", unknown → "not found".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

/** A runAgent that never settles, so the record stays running. */
function heldRun() {
  let createSession: ((session: any) => void) | undefined;
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        // Never resolves — the agent is "stuck", which is the point.
        // Sessions attach only when a test delivers one, like the real
        // session setup that runs after spawn returns.
        createSession = (session: any) => opts.onSessionCreated?.(session);
      }) as any,
  );
  return {
    create(session: any) {
      createSession?.(session);
    },
  };
}

/** Enough of an AgentSession for a record to count as resumable. */
function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "stop wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const stop = (tools: Map<string, any>, agent_id: string) =>
  tools.get("stop_subagent").execute("tc-stop", { agent_id }, undefined, undefined, ctx());

describe("stop_subagent", () => {
  it("is registered alongside the other lifecycle tools", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    expect(tools.has("stop_subagent")).toBe(true);
    await lifecycle.get("session_shutdown")?.();
  });

  it("stops a running agent and points at its partial output", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    const result = await stop(tools, id);
    expect(textOf(result)).toContain("Stopped");
    expect(textOf(result)).toContain("get_subagent_result");

    const check = await tools.get("get_subagent_result").execute(
      "tc-check",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(check)).toContain("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("stops by handle as well as by id", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    await spawnBackground(tools);
    await flush();

    // Single general-purpose agent → addressable as its type handle.
    const result = await stop(tools, "general-purpose");
    expect(textOf(result)).toContain("Stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("stops a queued agent behind a full pool", async () => {
    // The background pool holds 10; with 11 held agents the last one queues.
    // Queued abort takes the distinct dequeue branch (no slot, no completion
    // callback), so this pins the path the running-only tests never touch.
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push(await spawnBackground(tools));
    }
    await flush();

    const queuedId = ids[ids.length - 1];
    const check = await tools.get("get_subagent_result").execute(
      "tc-check-queued",
      { agent_id: queuedId },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(check)).toContain("queued");

    const result = await stop(tools, queuedId);
    expect(textOf(result)).toContain("Stopped");
    expect(textOf(result)).toContain("never started");

    const after = await tools.get("get_subagent_result").execute(
      "tc-check-stopped",
      { agent_id: queuedId },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(after)).toContain("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("a second stop reports nothing to stop", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const id = await spawnBackground(tools);
    await flush();

    await stop(tools, id);
    const again = await stop(tools, id);
    expect(textOf(again)).toContain("Nothing to stop");

    await lifecycle.get("session_shutdown")?.();
  });

  it("an unknown id reports not found", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const result = await stop(tools, "no-such-agent");
    expect(textOf(result)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.();
  });

  it("emits subagents:stopped for running and queued stops", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    heldRun();

    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push(await spawnBackground(tools));
    }
    await flush();
    const [runningId] = ids;
    const queuedId = ids[ids.length - 1];

    await stop(tools, runningId);
    await stop(tools, queuedId);

    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:stopped",
      expect.objectContaining({ id: runningId }),
    );
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:stopped",
      expect.objectContaining({ id: queuedId }),
    );

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("stop_subagent — resume interplay", () => {
  it("refuses a foreground resume of a live run with an actionable message", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const run = heldRun();

    const id = await spawnBackground(tools);
    await flush();
    // The session materializes after spawn, as in production — without it the
    // tool refuses earlier with \"no active session\", never reaching the guard.
    run.create(fakeSession());
    await flush();

    const res = await tools.get("Agent").execute(
      "tc-resume-live",
      {
        prompt: "more",
        description: "resume live run",
        subagent_type: "general-purpose",
        resume: id,
        run_in_background: false,
      },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(res)).toContain("can only be resumed once");
    expect(textOf(res)).toContain("steer_subagent");

    await lifecycle.get("session_shutdown")?.();
  });
});
