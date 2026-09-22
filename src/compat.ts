/**
 * compat.ts — pi-version compatibility in one place.
 *
 * Rule for new pi-core API uses: capability-detect here, never version-parse.
 * Every entry documents the fork (what changed, in which pi), the detection,
 * and the fallback — so the next upgrade is a checklist over this file,
 * not archaeology across src/.
 *
 * Known forks:
 * - modelRegistry -> modelRuntime (0.80.8): handled inline in agent-runner
 *   (both passed); not repeated here.
 * - AgentState.systemPrompt readonly (0.86): assigned before, replayed from
 *   transcript system messages after. See setSystemPromptText.
 * - TranscriptContext (0.86): providers receive messages-only context; tool
 *   declarations and prompts live in transcript system messages. Test
 *   harness reads handle both shapes (see sessionToolNames,
 *   transcriptSystemPrompt in test/helpers).
 * - bash_execution_update / thinking deltas: consumed opportunistically
 *   (see agent-runner event switch); absence degrades to coarser heartbeat,
 *   never to failure.
 */

/** Minimal session-state shape for prompt surgery (structural, for tests). */
export interface PromptStateLike {
  systemPrompt?: string;
  messages: { role: string; content?: unknown }[];
}

/**
 * Copy a live system prompt into a forked session, across pi versions.
 *
 * Try the direct assignment first so old cores behave byte-identically,
 * and fall back to prepending a system message — the documented 0.86+
 * path ("content adds instructions") and inert on cores that ignore the
 * role. Pure apart from the two writes.
 */
export function setSystemPromptText(state: PromptStateLike, systemPrompt: string): void {
  try {
    (state as { systemPrompt?: string }).systemPrompt = systemPrompt;
    return;
  } catch {
    // Getter-only state (0.86+): fall through to the transcript path.
  }
  state.messages.unshift({ role: "system", content: systemPrompt });
}

/** Structural surface checkCoreContract inspects (no pi imports). */
export interface CoreContractInput {
  sessionManager?: {
    list?: unknown;
    listAll?: unknown;
    getSessionDir?: unknown;
    getSessionId?: unknown;
  } | null;
  ui?: {
    custom?: unknown;
    select?: unknown;
    notify?: unknown;
  } | null;
  mode?: string;
}

/**
 * Probe the host's API surface for contracts this extension depends on.
 * Returns human-readable warnings (empty = clean). Capability checks only —
 * no version strings to rot. Called once per session_start; the caller
 * decides how loudly to surface (notify in tui, warn in headless).
 */
export function checkCoreContract(input: CoreContractInput): string[] {
  const warnings: string[] = [];
  const sm = input.sessionManager;
  if (typeof sm?.list !== "function") {
    warnings.push("SessionManager.list is missing — session listing (/resume-filtered) cannot work.");
  }
  if (typeof sm?.listAll !== "function") {
    warnings.push("SessionManager.listAll is missing — all-folder listing (/resume-filtered all) cannot work.");
  }
  if (typeof sm?.getSessionDir !== "function") {
    warnings.push("sessionManager.getSessionDir is missing — per-folder session scope cannot resolve.");
  }
  if (typeof sm?.getSessionId !== "function") {
    warnings.push("sessionManager.getSessionId is missing — transcripts, schedules and run identity cannot resolve.");
  }
  // UI surface only matters where a terminal exists; print/rpc modes stub it.
  if (input.mode === "tui") {
    if (typeof input.ui?.custom !== "function") {
      warnings.push("ctx.ui.custom is missing — tree picker, dialogs and settings UI cannot open.");
    }
    if (typeof input.ui?.select !== "function") {
      warnings.push("ctx.ui.select is missing — menus fall back to nothing; workflows/settings selection breaks.");
    }
  }
  if (typeof input.ui?.notify !== "function" && input.mode === "tui") {
    warnings.push("ctx.ui.notify is missing — user-facing warnings have nowhere to go.");
  }
  return warnings;
}
