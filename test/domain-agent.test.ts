/**
 * domain-agent.test.ts — the settle precedence table, exhaustively.
 *
 * Every row used to be an if-branch in one of four manager call sites. If a
 * row fails, the manager delegation changed behavior — not the table.
 */
import { describe, expect, it } from "vitest";
import { reduceSettle } from "../src/domain/agent.js";

describe("reduceSettle resolved", () => {
  it("stopped wins over everything, touching nothing else", () => {
    expect(reduceSettle({ kind: "resolved", stopped: true, aborted: true, steered: true, failure: "x" })).toEqual({
      status: "stopped",
    });
  });

  it("orders aborted > error > steered > completed", () => {
    expect(reduceSettle({ kind: "resolved", stopped: false, aborted: true, steered: true })).toEqual({
      status: "aborted",
    });
    expect(
      reduceSettle({ kind: "resolved", stopped: false, aborted: false, steered: true, failure: "boom" }),
    ).toEqual({ status: "error", error: "boom" });
    expect(reduceSettle({ kind: "resolved", stopped: false, aborted: false, steered: true })).toEqual({
      status: "steered",
    });
    expect(reduceSettle({ kind: "resolved", stopped: false, aborted: false, steered: false })).toEqual({
      status: "completed",
    });
  });

  it("empty failure counts as no failure (legacy truthiness)", () => {
    expect(reduceSettle({ kind: "resolved", stopped: false, aborted: false, steered: false, failure: "" })).toEqual({
      status: "completed",
    });
  });
});

describe("reduceSettle rejected", () => {
  it("non-stopped rejections are errors with the message", () => {
    expect(reduceSettle({ kind: "rejected", stopped: false, error: "nope", keepErrorWhenStopped: true })).toEqual({
      status: "error",
      error: "nope",
    });
  });

  it("spawn path keeps the error even when stopped (pinned quirk)", () => {
    expect(reduceSettle({ kind: "rejected", stopped: true, error: "AbortError", keepErrorWhenStopped: true })).toEqual({
      status: "stopped",
      error: "AbortError",
    });
  });

  it("resume paths leave stopped records alone", () => {
    expect(
      reduceSettle({ kind: "rejected", stopped: true, error: "AbortError", keepErrorWhenStopped: false }),
    ).toEqual({ status: "stopped" });
  });
});
