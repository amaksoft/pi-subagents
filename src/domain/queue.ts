/**
 * domain/queue.ts — pure concurrency-pool admission and slot ledger.
 *
 * Phase-1 strangler seam: everything here is data-in/data-out with zero
 * imports from the manager, pi-core, or node. The manager owns one ledger
 * struct and delegates every pool decision to these functions; the ledger
 * never calls back.
 *
 * Invariants (previously comments scattered across agent-manager.ts):
 * - Nested/workflow children take no slot: their owner already holds one, so
 *   counting them could deadlock a parent waiting on its own child.
 * - A lease captures its pool at acquire time. Release takes the lease, never
 *   a recomputed pool — a mid-run settings change cannot make the release
 *   disagree with the acquire.
 * - Releases clamp at zero: a double-release lifts the limit permanently, so
 *   the ledger refuses to go negative rather than trusting every caller.
 */

/** Which concurrency pool a spawn is charged to, if any. */
export type Pool = "background" | "foreground";

/** Proof a slot is held. Opaque to callers; release consumes it. */
export interface SlotLease {
  pool: Pool;
  permitId: number;
}

/** The ledger. Counters plus caps plus a permit sequence. */
export interface PoolLedger {
  background: number;
  foreground: number;
  maxBackground: number;
  /** 0 = unlimited (the foreground default). */
  maxForeground: number;
  nextPermit: number;
}

export function emptyLedger(maxBackground: number, maxForeground: number): PoolLedger {
  return { background: 0, foreground: 0, maxBackground, maxForeground, nextPermit: 1 };
}

/**
 * Which pool a spawn is charged to, or undefined for one charged to neither
 * (nested children, detached non-background spawns).
 */
export function resolvePool(
  spawn: { isBackground?: boolean; blocking?: boolean; topLevel: boolean },
  maxForeground: number,
): Pool | undefined {
  if (spawn.isBackground && spawn.topLevel) return "background";
  if (maxForeground > 0 && spawn.blocking && spawn.topLevel) return "foreground";
  return undefined;
}

/** Whether a pool has room right now (an unlimited pool always does). */
export function poolHasRoom(ledger: Pick<PoolLedger, "background" | "foreground" | "maxBackground" | "maxForeground">, pool: Pool): boolean {
  return pool === "background"
    ? ledger.background < ledger.maxBackground
    : ledger.maxForeground === 0 || ledger.foreground < ledger.maxForeground;
}

/**
 * Take a slot, returning the updated ledger and the lease. `force` bypasses
 * the room check (scheduler/bypassQueue spawns still count their slot and may
 * transiently exceed the limit). Callers that checked poolHasRoom first always
 * get a lease; callers that did not must handle undefined as "no room".
 */
export function acquireSlot(
  ledger: PoolLedger,
  pool: Pool,
  force = false,
): { ledger: PoolLedger; lease: SlotLease } | undefined {
  if (!force && !poolHasRoom(ledger, pool)) return undefined;
  const lease: SlotLease = { pool, permitId: ledger.nextPermit };
  const key = pool === "background" ? "background" : "foreground";
  return {
    ledger: { ...ledger, [key]: ledger[key] + 1, nextPermit: ledger.nextPermit + 1 },
    lease,
  };
}

/** Hand a lease back. Clamps at zero — a double-release must not lift the limit. */
export function releaseSlot(ledger: PoolLedger, lease: SlotLease): PoolLedger {
  const key = lease.pool === "background" ? "background" : "foreground";
  return { ...ledger, [key]: Math.max(0, ledger[key] - 1) };
}
