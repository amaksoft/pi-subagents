/**
 * group-join.ts — Manages grouped background agent completion notifications.
 *
 * Instead of each agent individually nudging the main agent on completion,
 * agents in a group are held until all complete (or a timeout fires),
 * then a single consolidated notification is sent.
 */

import type { AgentRecord } from "./types.js";

export type DeliveryCallback = (records: AgentRecord[], partial: boolean) => void;

/**
 * Envelope label for a grouped completion notification. Status-aware: a group
 * whose members did not all complete says so, instead of a blanket "finished".
 */
export function groupCompletionLabel(unconsumed: Pick<AgentRecord, "status">[], partial: boolean): string {
  const incomplete = unconsumed.filter(r => r.status !== "completed").length;
  if (partial) return `${unconsumed.length} agent(s) finished (partial — others still running)`;
  const stopped = unconsumed.filter(r => r.status === "stopped").length;
  if (incomplete > 0 && stopped === incomplete) return `${unconsumed.length} agent(s) finished (${stopped} stopped)`;
  if (incomplete > 0) return `${unconsumed.length} agent(s) finished (partial — ${incomplete} did not complete)`;
  return `${unconsumed.length} agent(s) finished`;
}

interface AgentGroup {
  groupId: string;
  agentIds: Set<string>;
  completedRecords: Map<string, AgentRecord>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  delivered: boolean;
  /** Shorter timeout for stragglers after a partial delivery. */
  isStraggler: boolean;
}

/** Default timeout: 30s after first completion in a group. */
const DEFAULT_TIMEOUT = 30_000;
/** Straggler re-batch timeout: 15s. */
const STRAGGLER_TIMEOUT = 15_000;

export class GroupJoinManager {
  private groups = new Map<string, AgentGroup>();
  private agentToGroup = new Map<string, string>();

  constructor(
    private deliverCb: DeliveryCallback,
    private groupTimeout = DEFAULT_TIMEOUT,
  ) {}

  /** Register a group of agent IDs that should be joined. */
  registerGroup(groupId: string, agentIds: string[]): void {
    const group: AgentGroup = {
      groupId,
      agentIds: new Set(agentIds),
      completedRecords: new Map(),
      delivered: false,
      isStraggler: false,
    };
    this.groups.set(groupId, group);
    for (const id of agentIds) {
      this.agentToGroup.set(id, groupId);
    }
  }

  /**
   * Called when an agent completes.
   * Returns:
   * - 'pass'      — agent is not grouped, caller should send individual nudge
   * - 'held'      — result held, waiting for group completion
   * - 'delivered'  — this completion triggered the group notification
   */
  onAgentComplete(record: AgentRecord): 'delivered' | 'held' | 'pass' {
    const groupId = this.agentToGroup.get(record.id);
    if (!groupId) return 'pass';

    const group = this.groups.get(groupId);
    if (!group || group.delivered) return 'pass';

    group.completedRecords.set(record.id, record);

    // All done — deliver immediately
    if (group.completedRecords.size >= group.agentIds.size) {
      this.deliver(group, false);
      return 'delivered';
    }

    // First completion in this batch — start timeout
    if (!group.timeoutHandle) {
      const timeout = group.isStraggler ? STRAGGLER_TIMEOUT : this.groupTimeout;
      group.timeoutHandle = setTimeout(() => {
        this.onTimeout(group);
      }, timeout);
    }

    return 'held';
  }

  private onTimeout(group: AgentGroup): void {
    if (group.delivered) return;
    group.timeoutHandle = undefined;

    // Partial delivery — some agents still running
    const remaining = new Set<string>();
    for (const id of group.agentIds) {
      if (!group.completedRecords.has(id)) remaining.add(id);
    }

    // Clean up agentToGroup for delivered agents (they won't complete again)
    for (const id of group.completedRecords.keys()) {
      this.agentToGroup.delete(id);
    }

    // Deliver what we have
    this.deliverCb([...group.completedRecords.values()], true);

    // Set up straggler group for remaining agents
    group.completedRecords.clear();
    group.agentIds = remaining;
    group.isStraggler = true;
    // Timeout will be started when the next straggler completes
  }

  private deliver(group: AgentGroup, partial: boolean): void {
    if (group.timeoutHandle) {
      clearTimeout(group.timeoutHandle);
      group.timeoutHandle = undefined;
    }
    group.delivered = true;
    this.deliverCb([...group.completedRecords.values()], partial);
    this.cleanupGroup(group.groupId);
  }

  private cleanupGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const id of group.agentIds) {
      this.agentToGroup.delete(id);
    }
    this.groups.delete(groupId);
  }

  /** Check if an agent is in a group. */
  isGrouped(agentId: string): boolean {
    return this.agentToGroup.has(agentId);
  }

  dispose(): void {
    for (const group of this.groups.values()) {
      if (group.timeoutHandle) clearTimeout(group.timeoutHandle);
    }
    this.groups.clear();
    this.agentToGroup.clear();
  }
}
