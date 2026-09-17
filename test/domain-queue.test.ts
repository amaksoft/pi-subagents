/**
 * domain-queue.test.ts — pure pool admission and slot ledger.
 *
 * No manager, no mocks: these are data-in/data-out functions, which is the
 * whole point of the seam. Every invariant below used to live as a comment
 * in agent-manager.ts; now it is an assertion.
 */
import { describe, expect, it } from "vitest";
import {
  acquireSlot,
  emptyLedger,
  poolHasRoom,
  releaseSlot,
  resolvePool,
} from "../src/domain/queue.js";

describe("resolvePool", () => {
  it("charges top-level background spawns to the background pool", () => {
    expect(resolvePool({ isBackground: true, topLevel: true }, 5)).toBe("background");
  });

  it("charges nothing for nested and workflow children (deadlock avoidance)", () => {
    // Parent holds the slot already; counting the child could deadlock a
    // parent waiting on its own child.
    expect(resolvePool({ isBackground: true, topLevel: false }, 5)).toBeUndefined();
  });

  it("charges blocking top-level spawns to foreground only when capped", () => {
    expect(resolvePool({ blocking: true, topLevel: true }, 5)).toBe("foreground");
    expect(resolvePool({ blocking: true, topLevel: true }, 0)).toBeUndefined();
    expect(resolvePool({ blocking: true, topLevel: false }, 5)).toBeUndefined();
  });

  it("charges detached non-background spawns nowhere", () => {
    expect(resolvePool({ topLevel: true }, 5)).toBeUndefined();
  });
});

describe("poolHasRoom", () => {
  it("caps background, treats foreground 0 as unlimited", () => {
    const ledger = { ...emptyLedger(1, 0), background: 1 };
    expect(poolHasRoom(ledger, "background")).toBe(false);
    expect(poolHasRoom(ledger, "foreground")).toBe(true);
    expect(poolHasRoom(emptyLedger(10, 2), "background")).toBe(true);
  });
});

describe("acquireSlot / releaseSlot", () => {
  it("leases capture their pool; release honors the lease, not a recompute", () => {
    let ledger = emptyLedger(10, 10);
    const a = acquireSlot(ledger, "background")!;
    ledger = a.ledger;
    expect(a.lease).toMatchObject({ pool: "background", permitId: 1 });
    expect(ledger.background).toBe(1);
    // A mid-run settings change cannot move the release: the lease says where.
    ledger = { ...ledger, maxBackground: 0 };
    ledger = releaseSlot(ledger, a.lease);
    expect(ledger.background).toBe(0);
  });

  it("refuses without force when full; force transiently exceeds", () => {
    const full = { ...emptyLedger(1, 10), background: 1 };
    expect(acquireSlot(full, "background")).toBeUndefined();
    const forced = acquireSlot(full, "background", true)!;
    expect(forced.ledger.background).toBe(2);
  });

  it("clamps double-release at zero instead of lifting the limit", () => {
    let ledger = emptyLedger(1, 10);
    const a = acquireSlot(ledger, "background")!;
    ledger = releaseSlot(releaseSlot(a.ledger, a.lease), a.lease);
    expect(ledger.background).toBe(0);
    expect(poolHasRoom(ledger, "background")).toBe(true);
  });

  it("permit ids are unique across pools", () => {
    const ledger = emptyLedger(10, 10);
    const a = acquireSlot(ledger, "background")!;
    const b = acquireSlot(a.ledger, "foreground")!;
    expect(a.lease.permitId).not.toBe(b.lease.permitId);
  });
});
