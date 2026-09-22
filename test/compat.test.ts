/**
 * compat.test.ts — version-compatibility surface.
 *
 * checkCoreContract must stay silent on the full current surface and name
 * every missing piece (it is the upgrade tripwire: a new pi that moves an
 * API should produce a warning here, not a silent behavior change).
 * setSystemPromptText is covered through its re-export in
 * mention-clone.test.ts (both state shapes); here just the delegation.
 */
import { describe, expect, it } from "vitest";
import { checkCoreContract, setSystemPromptText } from "../src/compat.js";

const fullSurface = () => ({
  sessionManager: {
    list: () => {},
    listAll: () => {},
    getSessionDir: () => {},
    getSessionId: () => {},
  },
  ui: {
    custom: () => {},
    select: () => {},
    notify: () => {},
  },
  mode: "tui",
});

describe("checkCoreContract", () => {
  it("is silent on the complete current surface", () => {
    expect(checkCoreContract(fullSurface())).toEqual([]);
  });

  it("names each missing piece", () => {
    const warnings = checkCoreContract({
      sessionManager: { list: () => {} },
      ui: {},
      mode: "tui",
    });
    const text = warnings.join("\n");
    expect(text).toContain("listAll");
    expect(text).toContain("getSessionDir");
    expect(text).toContain("getSessionId");
    expect(text).toContain("ui.custom");
    expect(text).toContain("ui.select");
    // list itself is present: no complaint about it.
    expect(text).not.toContain("SessionManager.list is missing");
  });

  it("skips UI checks outside tui mode (print/rpc stub it)", () => {
    expect(
      checkCoreContract({ sessionManager: fullSurface().sessionManager, ui: {}, mode: "print" }),
    ).toEqual([]);
  });

  it("tolerates entirely absent surfaces without throwing", () => {
    expect(checkCoreContract({})).not.toHaveLength(0);
    expect(checkCoreContract({ sessionManager: null, ui: null })).not.toHaveLength(0);
  });
});

describe("setSystemPromptText delegation", () => {
  it("prefers direct assignment on plain (old-core) state", () => {
    const state = { messages: [] as { role: string; content?: unknown }[] };
    setSystemPromptText(state, "hello");
    expect((state as { systemPrompt?: string }).systemPrompt).toBe("hello");
    expect(state.messages).toEqual([]);
  });
});

describe("session_start contract guard (wired)", () => {
  it("warns once per missing API on a degraded host", async () => {
    const { default: subagentsExtension } = await import("../src/index.js");
    const { vi: vitest } = await import("vitest");
    const lifecycle = new Map<string, any>();
    const notified: string[] = [];
    const warned: string[] = [];
    const pi = {
      registerMessageRenderer: vitest.fn(),
      registerTool: vitest.fn(),
      registerCommand: vitest.fn(),
      registerEntryRenderer: vitest.fn(),
      registerFlag: vitest.fn(),
      getFlag: vitest.fn(),
      on: vitest.fn((event: string, handler: any) => lifecycle.set(event, handler)),
      events: { emit: vitest.fn(), on: vitest.fn(() => vitest.fn()) },
      appendEntry: vitest.fn(),
      sendMessage: vitest.fn(),
    } as any;
    subagentsExtension(pi);
    const ctx: any = {
      hasUI: false,
      mode: "tui",
      ui: { notify: (m: string) => { notified.push(m); }, addAutocompleteProvider: vitest.fn() },
      cwd: "/tmp",
      modelRegistry: { find: vitest.fn(), getAvailable: vitest.fn(() => []) },
      // Degraded host: session listing present, everything else gone.
      sessionManager: { list: async () => [], getSessionId: () => "s1" },
      getSystemPrompt: vitest.fn(() => ""),
    };
    const warn = console.warn;
    console.warn = (m: string) => { warned.push(String(m)); };
    try {
      await lifecycle.get("session_start")({}, ctx);
    } finally {
      console.warn = warn;
    }
    const all = [...warned, ...notified].join("\n");
    expect(all).toContain("listAll");
    expect(all).toContain("getSessionDir");
    expect(all).toContain("ui.custom");
    // Present surface stays silent.
    expect(all).not.toContain("SessionManager.list is missing");
  });
});
