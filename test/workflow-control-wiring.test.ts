/**
 * workflow-control-wiring.test.ts — the workflow_control tool handler's
 * guard rails: unknown runs, missing refs, misplaced prompt. Live-task
 * behavior is covered by control.ts units (resolution) and runtime tests
 * (skip/retry semantics); here we prove the handler refuses safely.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("workflow_control guards", () => {
  let tools: Map<string, any>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function tool() {
    const { pi, tools: t } = makePi();
    tools = t;
    subagentsExtension(pi);
    return tools.get("workflow_control");
  }

  it("is registered alongside the other subagent tools", async () => {
    const t = await tool();
    expect(t).toBeDefined();
    expect(t.label).toBe("Workflow Control");
  });

  it("status with no runs says so", async () => {
    const t = await tool();
    expect(textOf(await t.execute("c", { action: "status" }, undefined, undefined, ctx()))).toContain(
      "No workflow runs",
    );
  });

  it("unknown run ids name the known (none here)", async () => {
    const t = await tool();
    expect(textOf(await t.execute("c", { action: "status", runId: "wf_deadbeef" }, undefined, undefined, ctx()))).toContain(
      "No workflow run",
    );
  });

  it("non-status actions require a run", async () => {
    const t = await tool();
    expect(
      textOf(await t.execute("c", { action: "stop_run" }, undefined, undefined, ctx())),
    ).toContain("`runId` is required");
  });

  it("prompt combines only with retry", async () => {
    const t = await tool();
    expect(
      textOf(
        await t.execute("c", { action: "stop_agent", runId: "wf_x", prompt: "narrow" }, undefined, undefined, ctx()),
      ),
    ).toContain("only combines with `retry_agent`");
  });
});
