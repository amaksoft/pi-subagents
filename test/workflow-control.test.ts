/**
 * workflow-control.test.ts — run-scoped addressing for the main session.
 *
 * Pure resolution only: execution delegates to the dialog-tested control.*
 * transitions, so there is nothing to re-prove here beyond reaching them.
 */
import { describe, expect, it } from "vitest";
import { resolveWorkflowAgent } from "../src/workflow/control.js";

const entries = [
  { index: 0, label: "review" },
  { index: 1, label: "verify" },
  { index: 2, label: "Review" },
];

describe("resolveWorkflowAgent", () => {
  it("prefers index when both are given", () => {
    expect(resolveWorkflowAgent(entries, { index: 1, label: "review" })).toEqual({ ok: true, index: 1 });
  });

  it("rejects unknown indexes listing the known", () => {
    const r = resolveWorkflowAgent(entries, { index: 9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("0, 1, 2");
  });

  it("matches labels exactly, then case-insensitively", () => {
    expect(resolveWorkflowAgent(entries, { label: "verify" })).toEqual({ ok: true, index: 1 });
    expect(resolveWorkflowAgent([{ index: 0, label: "Review" }], { label: "review" })).toEqual({
      ok: true,
      index: 0,
    });
  });

  it("ambiguity errors with indexed candidates", () => {
    const r = resolveWorkflowAgent(entries, { label: "REVIEW" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Ambiguous");
      expect(r.message).toContain("#0");
      expect(r.message).toContain("#2");
    }
  });

  it("unknown labels list the known, missing refs demand one", () => {
    const r = resolveWorkflowAgent(entries, { label: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("review");
    expect(resolveWorkflowAgent(entries, {}).ok).toBe(false);
    expect(resolveWorkflowAgent([], { label: "x" }).ok).toBe(false);
  });
});
