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
    getSessionDir: () => {},
    getSessionId: () => {},
  },
  sessionList: {
    list: () => {},
    listAll: () => {},
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
      sessionManager: { getSessionId: () => {} },
      sessionList: { list: () => {} },
      ui: {},
      mode: "tui",
    });
    const text = warnings.join("\n");
    expect(text).toContain("listAll");
    expect(text).toContain("getSessionDir");
    expect(text).toContain("ui.custom");
    expect(text).toContain("ui.select");
    // Present surface stays silent.
    expect(text).not.toContain("SessionManager.list is missing");
    expect(text).not.toContain("getSessionId is missing");
  });

  it("checks listing on the class, not the instance (list is static)", () => {
    // Instance-shaped object with list on it must NOT satisfy the probe:
    // the real contract is SessionManager.list, a static.
    const warnings = checkCoreContract({
      ...fullSurface(),
      sessionList: {},
    });
    expect(warnings.join("\n")).toContain("SessionManager.list is missing");
  });

  it("skips UI checks outside tui mode (print/rpc stub it)", () => {
    const full = fullSurface();
    expect(
      checkCoreContract({
        sessionManager: full.sessionManager,
        sessionList: full.sessionList,
        ui: {},
        mode: "print",
      }),
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

// Top-level so the full-extension boot cost stays out of the test timeout.
// eslint-disable-next-line import/first
import subagentsExtension from "../src/index.js";

describe("session_start contract guard (wired)", () => {
  // Boots the whole extension: generous budget under parallel-worker load.
  it("warns once per missing API on a degraded host", { timeout: 30_000 }, async () => {
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
      // Degraded host: static listing present, everything else gone.
      sessionManager: { getSessionId: () => "s1" },
      sessionList: { list: async () => [] } as any,
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
    // Instance + UI sides degrade through the mock. The static side
    // (SessionManager.list/listAll) always uses the real imported class
    // here, so it stays silent — its absence is covered by the unit tests.
    expect(all).toContain("getSessionDir");
    expect(all).toContain("ui.custom");
    // Present surface stays silent.
    expect(all).not.toContain("SessionManager.list is missing");
    expect(all).not.toContain("listAll is missing");
    expect(all).not.toContain("getSessionId is missing");
  });
});
