/**
 * workflow/control.ts — pure helpers for the main session's workflow controls.
 *
 * Workflow children belong to their run: the top-level stop/steer/result
 * tools refuse them, so the main session reaches them here — addressed by
 * (runId, label|index), executed through the same control.* transitions the
 * dialog uses (identical barrier/journal accounting, no new settle paths).
 * Pure and tested directly; index.ts wires manager + tasks around it.
 */

export interface WorkflowAgentRef {
  label?: string;
  index?: number;
}

export interface WorkflowAgentEntryLike {
  index: number;
  label: string;
}

export type AgentResolution =
  | { ok: true; index: number }
  | { ok: false; message: string };

/**
 * Resolve a human reference to a runtime agent index. Index wins when both
 * are given (labels repeat across phases); labels match exactly, then
 * case-insensitively; ambiguity errors list the candidates.
 */
export function resolveWorkflowAgent(
  entries: readonly WorkflowAgentEntryLike[],
  ref: WorkflowAgentRef,
): AgentResolution {
  if (ref.index !== undefined) {
    const hit = entries.find(e => e.index === ref.index);
    if (!hit) {
      const known = entries.map(e => e.index).join(", ");
      return { ok: false, message: `No workflow agent at index ${ref.index}. Known: ${known || "(none)"}.` };
    }
    return { ok: true, index: hit.index };
  }
  const label = ref.label?.trim();
  if (!label) {
    return { ok: false, message: "Name a label or index — see the status listing." };
  }
  const exact = entries.filter(e => e.label === label);
  if (exact.length === 1) return { ok: true, index: exact[0].index };
  const folded = entries.filter(e => e.label.toLowerCase() === label.toLowerCase());
  if (folded.length === 1) return { ok: true, index: folded[0].index };
  const pool = (exact.length > 0 ? exact : folded.length > 0 ? folded : entries)
    .map(e => `#${e.index} ${e.label}`);
  return {
    ok: false,
    message: exact.length > 1 || folded.length > 1
      ? `Ambiguous label "${label}" — say the index: ${pool.join("; ")}.`
      : `No workflow agent labeled "${label}". Known: ${pool.join("; ") || "(none)"}.`,
  };
}
