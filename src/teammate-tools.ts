/**
 * teammate-tools.ts — agent-to-agent mail for the implicit session team.
 *
 * Every top-level agent is a teammate of every other top-level agent in the
 * session (same shape as Claude Code's one-team-per-session, without the
 * preview flag). Mail is attribution + inbox + delivery through the steer
 * channel: the envelope names the sender, the inbox keeps history (steer
 * messages are fire-and-forget), and delivery interrupts after the current
 * tool call exactly like a steer — a queued-but-silent mailbox would be a
 * wedge nobody can see.
 *
 * Ownership matches stop/steer: nested children reach only through their
 * parent, workflow children through their run. The main session sends as
 * "main session" via its own `message_teammate` closure in index.ts.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentRecord } from "./types.js";

/** Inbox bound per record — mail is signal, not storage. Oldest drops first. */
export const TEAMMATE_INBOX_CAP = 20;

export interface TeammateDelivery {
  ok: boolean;
  /** Human refusal when !ok (unknown, settled, or not a teammate). */
  reason?: string;
}

/** Narrow manager surface this module needs (mirrors nested-tools.ts). */
export interface TeammateManager {
  deliverTeammateMessage(fromLabel: string, toId: string, text: string): TeammateDelivery;
  listTeammates(): AgentRecord[];
}

export interface TeammateToolContext {
  manager: TeammateManager;
  /** Stamped as the sender. A label (main session, @handle), never an id. */
  senderLabel: string;
  /** Record id of the sender (child-side only): messaging yourself refuses. */
  selfId?: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

/** Resolve handle, alias, or id among teammates (case-insensitive names). */
export function resolveTeammateRef(teammates: readonly AgentRecord[], ref: string): AgentRecord | undefined {
  const want = ref.trim().toLowerCase();
  return (
    teammates.find(r => r.handle?.toLowerCase() === want) ??
    teammates.find(r => r.alias?.toLowerCase() === want) ??
    teammates.find(r => r.id === ref)
  );
}

/** Crewed names for the refusal — a judge that mistypes needs the roster. */
export function teammateRoster(teammates: readonly AgentRecord[]): string {
  const names = teammates.map(r => r.handle ?? r.alias ?? r.id);
  return names.length > 0 ? names.join(", ") : "(no other teammates running)";
}

export function createTeammateTools(context: TeammateToolContext): ToolDefinition[] {
  const messageTool = defineTool({
    name: "message_teammate",
    label: "Message Teammate",
    description:
      "Send a message to a fellow top-level agent in this session (your teammates). " +
      "Delivered into their conversation after their current tool call, stamped with your name, " +
      "and kept in their inbox. Use it to hand off findings, ask for input, or coordinate — " +
      "not to supervise: you cannot reach nested children (message their parent) or workflow agents (use the run's controls).",
    parameters: Type.Object({
      target: Type.String({
        description: "Teammate handle, alias, or agent id. Siblings only — nested children and workflow agents are unreachable.",
      }),
      message: Type.String({ description: "The message. Attributed to you on delivery." }),
    }),
    execute: async (_toolCallId, params) => {
      // Top-level records only — ownership boundary, same as stop/steer.
      const teammates = context.manager.listTeammates();
      const target = resolveTeammateRef(teammates, params.target);
      if (!target) {
        return textResult(
          `Teammate not found: "${params.target}". Messageable: ${teammateRoster(teammates)}.`,
          true,
        );
      }
      if (target.id === context.selfId) {
        return textResult("That is you — talk to yourself in your own turn.", true);
      }
      const delivery = context.manager.deliverTeammateMessage(context.senderLabel, target.id, params.message);
      return delivery.ok
        ? textResult(`Message delivered to ${target.handle ?? target.alias ?? target.id}. It arrives after their current tool call.`)
        : textResult(delivery.reason ?? `Could not deliver to ${target.id}.`, true);
    },
  });
  return [messageTool];
}
