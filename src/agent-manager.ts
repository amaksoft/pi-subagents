/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached agents.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import { reduceSettle, StartupError } from "./domain/agent.js";
import { MAX_TIMEOUT_MS } from "./workflow/task.js";
import {
  acquireSlot,
  emptyLedger,
  poolHasRoom as ledgerHasRoom,
  type Pool,
  releaseSlot as releaseLedgerSlot,
  resolvePool,
} from "./domain/queue.js";
import { DEFAULT_STALL_THRESHOLD_MS, isStalled, isStoppableStatus, pushLiveOutput, touchActivity, touchOutput, trackToolActivity } from "./status-note.js";
import type { AgentInvocation, AgentRecord, AgentTombstone, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
/** Fired exactly once per successful abort(), queued or running. */
export type OnAgentStop = (record: AgentRecord) => void;
/** Fired once per stall episode, when the sweep first flags a silent agent. */
export type OnAgentStall = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 *
 * The single definition behind every user-facing surface — the fleet list, the
 * widget, the `/agents` menus, `@handle` resolution, and the completion events
 * and session entries. An owned child reports through its owner, so surfacing
 * it separately would double-count the same work in the places a person reads.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

/**
 * Eligibility message for a top-level stop call. Returns the refusal text, or
 * undefined when the record exists, is top-level, and is still stoppable.
 * Pure so the ownership boundary is pinned without a live session.
 */
export function topLevelStopRefusal(record: AgentRecord | undefined, id: string): string | undefined {
  if (!record) return `Agent not found: "${id}". It may have been cleaned up.`;
  if (!isTopLevelAgent(record)) {
    return `Agent "${id}" is not a top-level agent. Only the agent that spawned it can reach it — stop or steer the owning parent (stopping the parent stops all its children).`;
  }
  if (!isStoppableStatus(record.status)) {
    return `Agent "${id}" is not running (status: ${record.status}). Nothing to stop. Use get_subagent_result to read its output.`;
  }
  return undefined;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  /**
   * Per-run wall-clock budget in ms, counted from kickoff (queued time
   * excluded). Unset/non-positive = unlimited. Copied to the record at
   * kickoff; the timer is armed there too.
   */
  timeoutMs?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /**
   * The workflow run this child belongs to, when a workflow spawned it.
   *
   * Ownership, not decoration. A workflow's children are the workflow's — they
   * report through its card, its notification and its dialog, so they are
   * filtered out of every top-level surface exactly as nested children are, and
   * they take no `maxConcurrent` slot: the run has its own concurrency cap, and
   * counting them twice would let one workflow starve the whole session.
   */
  workflowId?: string;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema. Set only by the workflow host, for `agent({ schema })`.
   */
  structuredOutput?: CompiledSchema;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree — a workflow `gate` is the motivating case — has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onStop?: OnAgentStop;
  private onStall?: OnAgentStall;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  /**
   * The pool ledger (see domain/queue.ts). Caps live here — getMaxConcurrent
   * and friends read them — so admission and accounting share one struct.
   */
  private poolLedger = emptyLedger(DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_FOREGROUND);
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`, and is fired once the
   * entry's `start` has SETTLED rather than at drain time: startup is async
   * now, so releasing earlier would wake the caller before `record.promise`
   * exists and it would read a still-starting agent as one that never ran.
   * Removing an entry from this array MUST release it — a queued record has no
   * promise to await, and pi has no tool-execution timeout to bail the caller
   * out.
   */
  private queue: { id: string; pool: Pool; start: () => Promise<void>; release: () => void }[] = [];

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    onStop?: OnAgentStop,
    onStall?: OnAgentStall,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.onStop = onStop;
    this.onStall = onStall;
    this.poolLedger = emptyLedger(maxConcurrent, DEFAULT_MAX_CONCURRENT_FOREGROUND);
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.poolLedger = { ...this.poolLedger, maxBackground: Math.max(1, n) };
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.poolLedger.maxBackground;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.poolLedger = { ...this.poolLedger, maxForeground: Math.max(0, n) };
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.poolLedger.maxForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    return resolvePool(
      { isBackground: record.isBackground, blocking: record.blocking, topLevel: isTopLevelAgent(record) },
      this.poolLedger.maxForeground,
    );
  }

  private poolHasRoom(pool: Pool): boolean {
    return ledgerHasRoom(this.poolLedger, pool);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Owned children — nested, or a workflow's — are filtered out of every
      // top-level surface, so no handle: nothing can address them and they must
      // not consume a name a top-level sibling could otherwise take.
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record. Immediate starts
      // are "provisioning", never optimistically "running" — the run has
      // not kicked off until startAgent finishes setup (see M1).
      status: options.isBackground ? "queued" : "provisioning",
      toolUses: 0,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      epoch: 0,
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
    };
    this.agents.set(id, record);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    const pool = this.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.launch(id, record, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, record, args, undefined);
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        record.pendingSteers = undefined;
        try {
          this.onStop?.(record);
        } catch { /* a listener must never break the stop itself */ }
      }
      return false;
    }
    // Stored on the record (not just closed over): without a handle the
    // listener outlives the queue entry — leaking one closure per queued
    // spawn and risking a late abort landing on a settled record's id.
    // Cleared on start (launch), abort, and removal; each clears defensively
    // since the three can race (stop-then-start, start-then-stop).
    const onAbort = () => this.abort(id);
    signal.addEventListener("abort", onAbort, { once: true });
    const record = this.agents.get(id);
    if (record !== undefined) {
      record.detachQueuedAbort = () => signal.removeEventListener("abort", onAbort);
    }
    return true;
  }

  /** Drop a queued-abort listener that has served (started, aborted, gone). */
  private detachQueuedAbort(record: AgentRecord): void {
    record.detachQueuedAbort?.();
    record.detachQueuedAbort = undefined;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queuedPool - The pool this start was QUEUED on, or undefined for an
   *   immediate start. A queue drain can be minutes after `spawn()` returned,
   *   and nobody is awaiting `awaitStartup` by then, so a failure has to live
   *   on the record as status "error" — what drainQueue did when the throw was
   *   still synchronous. An immediate start instead drops the record, exactly
   *   as the throw out of `spawn()` did: no orphan in `listAgents()`, and the
   *   handle goes back.
   */
  /**
   * Single owner for startup-failure disposition (Phase-2 unification).
   * Queued starts park the failure on the record — nobody is awaiting at
   * drain time — while immediate starts delete the record and travel as a
   * StartupError through the startups channel, rethrown by spawnAndWait
   * (#179: pi only fails a tool call on throw). A stop that landed
   * mid-startup owns the record either way: neither relabeled (queued) nor
   * deleted (immediate), so get_subagent_result still finds it.
   * Returns the typed error for the caller to throw.
   */
  private failStartup(id: string, record: AgentRecord, err: unknown, queuedPool: Pool | undefined): StartupError {
    this.startups.delete(id);
    const failure = new StartupError(err instanceof Error ? err.message : String(err), {
      cause: err,
      queuedPool,
    });
    if (record.status !== "stopped") {
      if (queuedPool !== undefined) {
        // Mirrors settleRun: an inline caller gets this failure as a throw
        // out of spawnAndWait, so an unconsumed record would ALSO nudge the
        // session about it — the same failure reported twice.
        if (queuedPool === "foreground") record.resultConsumed = true;
        record.status = "error";
        record.error = failure.message;
        record.completedAt = Date.now();
        this.onComplete?.(record);
      } else {
        this.agents.delete(id);
      }
    }
    return failure;
  }

  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    // Leaving the queue (or starting now): the run exists but has not kicked
    // off — provisioning, not running and no longer merely queued.
    if (record.status === "queued") record.status = "provisioning";
    // startAgent wires its own parent-signal listener, so
    // the queued one retires here rather than doubling (or leaking) it.
    this.detachQueuedAbort(record);
    // Generation at launch: a resume started after this launch but before its
    // failure lands means a newer run owns the record — the stale failure
    // must not park/delete under it. (No slot juggling here either: whatever
    // slot exists belongs to the current generation by construction.)
    const launchEpoch = record.epoch;
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); },
      (err) => {
        if (record.epoch !== launchEpoch) {
          this.startups.delete(id);
          return;
        }
        const failure = this.failStartup(id, record, err, queuedPool);
        // The agent never kept its slot (startAgent gives it back on failure),
        // so anything queued behind it can go now.
        this.drainQueue();
        throw failure;
      },
    );
    this.startups.set(id, startup);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  /**
   * Resolves once the agent is actually running, and rejects with a
   * StartupError for startup failure (strict worktree isolation) that
   * `spawn()` used to throw before the repo copy became async. Resolves
   * immediately for an agent that is already running, still queued, or
   * unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
  ) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Take the concurrency slot — but NOT the running state — BEFORE the
    // first await. Creating a worktree is an awaited git call, and drainQueue
    // reads the pool counters synchronously in a loop: incrementing after the
    // await would let it start every queued agent at once while the first is
    // still copying its repo. The record stays "provisioning" until kickoff
    // below; abort()/abortAll() reach provisioning agents, so the stranded-
    // while-copying window stays covered without the optimistic-running lie.
    //
    // The pool is resolved ONCE, here, and carried to `settleRun` below:
    // `poolFor` reads `maxConcurrentForeground`, which the user can change from
    // `/agents → Settings` mid-run, so recomputing it at settle time would
    // decrement a pool this run never charged (counter underflow, limit
    // silently lifted) or skip the decrement for one it did (leaked slot —
    // every later blocking spawn queues forever). The two startup exits below
    // never reach `settleRun`, so they hand the slot back themselves.
    const pool = this.poolFor(record);
    const releaseSlot = () => {
      // Lease-carried release: the pool comes from acquire time, never from
      // a recompute — a mid-run settings change cannot misdirect it.
      if (record.slotLease !== undefined) {
        this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
        record.slotLease = undefined;
      }
    };
    record.startedAt = Date.now();
    record.startGate = undefined;
    if (pool !== undefined) {
      // Room was checked at spawn/drain time; bypassQueue skips the check but
      // still counts (transient overdraft, as before). The force fallback
      // preserves the old unconditional increment for the synchronous sliver
      // where room vanished between check and start.
      const acquired = acquireSlot(this.poolLedger, pool, options.bypassQueue)
        ?? acquireSlot(this.poolLedger, pool, true)!;
      this.poolLedger = acquired.ledger;
      record.slotLease = acquired.lease;
    }

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = await createWorktree(pi, baseCwd, id);
      if (!wt) {
        releaseSlot();
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);

      // No longer provisioning means a stop landed while the copy was being
      // made (abort(), abortAll()) — a window that did not exist when creation
      // was synchronous. The record is already terminal, so launching the run
      // would burn tokens on work nobody is waiting for: discard the fresh
      // (and by definition unchanged) worktree instead.
      if (record.status !== "provisioning") {
        releaseSlot();
        record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
        this.drainQueue();
        return;
      }
    }

    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      // A queued spawn can start minutes after the caller handed us its signal,
      // by which time it may already be aborted — and `addEventListener` would
      // never fire, leaving a child the parent can no longer reach.
      if (options.signal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      // Human-meaningful `/resume` session names (see buildSessionName):
      // the handle/alias identifies WHICH agent, the description says WHAT.
      handle: record.handle,
      alias: record.alias ?? undefined,
      description: record.description,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      background: record.isBackground === true,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        trackToolActivity(record, activity);
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: (delta, fullText) => {
        // Streaming text is output evidence as well as a sign of life.
        // Articulation also ends a reasoning stretch.
        record.reasoningSince = undefined;
        touchOutput(record);
        options.onTextDelta?.(delta, fullText);
      },
      onToolOutput: (delta) => {
        // Live tool stdout (bash deltas): bounded tail for the judge plus
        // a heartbeat — a build streaming output never flags.
        pushLiveOutput(record, delta);
        touchOutput(record);
      },
      onThinkingActivity: (phase) => {
        // Reasoning deltas prove work through a stretch with no tool calls
        // and no text — without this, a long think flags as stalled.
        // Heartbeat only: thinking is not judge-visible output.
        if (phase === "end") record.reasoningSince = undefined;
        else if (record.reasoningSince === undefined) record.reasoningSince = Date.now();
        touchActivity(record);
      },
      onAssistantUsage: (usage) => {
        touchActivity(record);
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        // Stale generation: a resume started a newer run on this record while
        // this one was unwinding — hands off everything it owns.
        if (record.epoch !== epoch) return responseText;
        // Precedence lives in domain/agent.reduceSettle (aborted > error >
        // steered > completed, stopped sticky); the manager only applies it.
        const decision = reduceSettle({
          kind: "resolved",
          stopped: record.status === "stopped",
          aborted,
          steered,
          failure,
        });
        record.status = decision.status;
        if (decision.error !== undefined) record.error = decision.error;
        record.result = responseText;
        // Kept beside `result`, never inside it: `result` is prose meant for a
        // reader — it is previewed, transcribed, and appended to below — while
        // this is a machine-readable payload one caller asked for by schema.
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          // The one moment the child's tree still exists and the child is done
          // writing to it. try/catch, not decoration: a hook that throws must
          // not leave the worktree behind.
          if (options.onBeforeWorktreeCleanup) {
            try {
              await options.onBeforeWorktreeCleanup(record.worktree.path);
            } catch { /* ignore — never block cleanup */ }
          }
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            // Appended to the prose only. A structured child's caller parses
            // `structuredJson`, which stays untouched — but `result` is also
            // what a human reads, so the note still belongs on it.
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
            if (wtResult.error) {
              record.result = `⚠ Worktree removal failed (${wtResult.error}); the branch is safe and the copy remains at \`${wtResult.path ?? "unknown path"}\`.\n\n---\n\n` + record.result;
            }
          } else if (wtResult.error) {
            // Cleanup failed mid-flight: the copy is preserved (see path) and
            // the parent must know the work is stranded, not merged.
            // Prepended, not appended: completion notifications preview the
            // FIRST 500 chars, so an appended warning would be truncated
            // away exactly when it matters most.
            record.result = `⚠ Worktree cleanup failed (${wtResult.error}); uncommitted work preserved at \`${wtResult.path ?? "unknown path"}\`.\n\n---\n\n` + (record.result ?? "");
          }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, true, pool);
        return responseText;
      })
      .catch(async (err) => {
        // Stale generation (see the .then above): hands off, new run owns it.
        if (record.epoch !== epoch) return "";
        // Spawn path keeps the rejection error even on stopped records
        // (resume paths do not) — carried explicitly, see reduceSettle.
        const decision = reduceSettle({
          kind: "rejected",
          stopped: record.status === "stopped",
          error: err instanceof Error ? err.message : String(err),
          keepErrorWhenStopped: true,
        });
        record.status = decision.status;
        if (decision.error !== undefined) record.error = decision.error;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, false, pool);
        return "";
      });

    // Kickoff: the run exists from here on, so provisioning ends. Set BEFORE
    // assigning the promise — waiters that observe a promise must never see a
    // record that still claims to be starting. The epoch is captured with it:
    // every settle handler below ignores completions from older generations
    // (abort→resume→old-settles must not touch the new run's status, result,
    // lease, or children).
    if (record.status === "provisioning") record.status = "running";
    const epoch = record.epoch;
    // Budget starts here — never at spawn, so queued time is free.
    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      record.timeoutMs = options.timeoutMs;
    }
    record.timeoutFired = undefined;
    this.armRunTimeout(id, record);
    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    options.onSpawned?.(id);
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and nowhere else. `abort()` on a running record
   * only fires its controller and leaves the run to settle normally, so
   * decrementing there too would double-free — permanently lifting the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param pool the pool this run was CHARGED TO at start time — passed in, not
   *   recomputed, so a mid-run change to `maxConcurrentForeground` can't make
   *   the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    if (!record.isBackground) record.resultConsumed = true;
    // Budget over: disarm first so a timer firing mid-settle cannot re-abort.
    this.disarmRunTimeout(record);
    // Lease release is idempotent (cleared on use): the two startup exits
    // that hand their slot back via releaseSlot() never reach here, and a
    // record that never acquired (pool-less) carries no lease to free.
    if (record.slotLease !== undefined) {
      this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
      record.slotLease = undefined;
    }

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // The isBackground half reproduces the pre-pool condition exactly — a
    // background settle has always drained, even for a nested child that held
    // no slot — so that path is unchanged whether or not the foreground pool is
    // on. The `pool` half only adds the drain a freed FOREGROUND slot needs.
    // A drain with nothing freed is a no-op anyway, but "no-op" is a claim
    // about reachability, and matching the old condition needs no such claim.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started — but are still
      // released, since nothing else will.
      if (!record || record.status !== "queued") { next.release(); continue; }
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      //
      // The release waits for that startup to SETTLE rather than firing here.
      // Startup is async now, so a release at drain time would wake a blocked
      // `spawnAndWait` while `record.promise` was still undefined, and it would
      // read a perfectly healthy agent as one that never ran.
      void next.start().then(() => next.release(), () => next.release());
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back — and it now
    // fires after an await (worktree creation) even on the immediate path.
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the immediate path owes its caller: pi only marks a tool result failed
    // when `execute` throws. A queued spawn's failure landed on the record
    // instead (nobody was awaiting `startups` at drain time) and is rethrown
    // below, so the contract is the same either way. A stop that landed
    // mid-startup owns the record instead: the failure is moot, swallow it
    // and let the caller render the stopped record below.
    try {
      await this.awaitStartup(id);
    } catch (err) {
      if (record.status !== "stopped") throw err;
    }

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders.
    if (record.promise) await record.promise;

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    // Never re-enter a run that is still in flight — foreground or background.
    // A second run would overwrite record.abortController (orphaning the live
    // run beyond stop's reach) and race on result/status/completedAt. The
    // background caller pre-checks this for a better message; the foreground
    // path relies on this guard (pi dispatches one message's tool calls via
    // Promise.all, so two resumes can overlap).
    if (record.status === "running" || record.status === "queued" || record.status === "provisioning") {
      return undefined;
    }

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      // (Re-entry is already refused above, for foreground and background
      // alike. The background-specific reason stands: detaching means the
      // caller gets control back while the record stays "running", so
      // nothing stops the model from resuming the same agent again. Starting
      // a second run would overwrite record.abortController — orphaning the
      // live run beyond the reach of `/agents` stop and abortAll() —
      // double-count the pool slot, and then reject from session.prompt()
      // with "Agent is already processing", whose settle path would abort
      // the LIVE run's children and report a failure for a run that is
      // still going.)
      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (occupiesPoolSlot(record) && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release. The
        // queue is shared with spawns, whose startup is async, so entries are
        // promise-shaped even though a resume starts synchronously; failures
        // land on the record here, since drainQueue no longer catches.
        this.queue.push({
          id,
          pool: "background",
          start: async () => {
            try {
              start();
            } catch (err) {
              record.status = "error";
              record.error = err instanceof Error ? err.message : String(err);
              record.completedAt = Date.now();
              this.onComplete?.(record);
            }
          },
          release: () => {},
        });
      } else {
        start();
      }
      return record;
    }

    // Foreground resume: run inline and return the settled record.
    // New generation (see startResume): late settlement from the previous
    // run on this record must not touch the new run.
    record.epoch++;
    const epoch = record.epoch;
    // Resumes carry no budget: disarm any timer the previous run armed so
    // an old deadline cannot kill the continuation.
    this.disarmRunTimeout(record);
    record.timeoutMs = undefined;
    record.timeoutFired = undefined;
    // Orphaned lease from an unsettled predecessor (aborted mid-flight):
    // its settle is epoch-barred from releasing, so free it here. A normally
    // settled predecessor already cleared it; foreground resumes never hold
    // a lease of their own, so release exactly covers the orphan.
    if (record.slotLease !== undefined) {
      this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
      record.slotLease = undefined;
    }
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    // Fresh abort controller so stop reaches THIS run (mirrors startAgent and
    // startResume): the previous run's controller is settled and detached, so
    // without this abort() would mark "stopped" while the session kept going.
    // (Closure: the "running" assignment above narrows the field in straight-
    // line scope, so the settle guards read through a function boundary
    // exactly like the .then() guards elsewhere in this file.)
    const isExternallyStopped = () => record.status === "stopped";
    const abortController = new AbortController();
    record.abortController = abortController;
    // A foreground caller awaiting inline still owns Esc: route the caller's
    // interrupt through abort() exactly like the spawn path, so it reads as
    // "stopped" rather than a provider-style "error".
    let detachCallerSignal: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) this.abort(id);
      else {
        const onCallerAbort = () => this.abort(id);
        signal.addEventListener("abort", onCallerAbort, { once: true });
        detachCallerSignal = () => signal.removeEventListener("abort", onCallerAbort);
      }
    }

    // Capture the session for the run below: property narrowing does not
    // cross the async-closure boundary.
    const session = record.session;
    // The run's promise, so waiters (get_subagent_result wait:true, waitForAll)
    // observe THIS run instead of the previous run's settled promise. Resolves
    // to "" like the spawn path's promise; callers only await it.
    record.promise = (async (): Promise<string> => {
      try {
        const { text, failure } = await resumeAgent(session, prompt, {
          onToolActivity: (activity) => {
            trackToolActivity(record, activity);
            options?.onToolActivity?.(activity);
          },
          onToolOutput: (delta) => {
            pushLiveOutput(record, delta);
            touchOutput(record);
          },
          onThinkingActivity: (phase) => {
            if (phase === "end") record.reasoningSince = undefined;
            else if (record.reasoningSince === undefined) record.reasoningSince = Date.now();
            touchActivity(record);
          },
          onAssistantUsage: (usage) => {
            touchActivity(record);
            addUsage(record.lifetimeUsage, usage);
            this.onUsage?.(record, usage);
            options?.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options?.onCompaction?.(info);
          },
          signal: abortController.signal,
        });
        // Stale generation: a newer resume owns the record — hands off.
        if (record.epoch !== epoch) return "";
        // Don't overwrite an external stop — mirrors every other settle path.
        // Without this a stop landing mid-run would be relabeled "completed".
        if (!isExternallyStopped()) {
          // Same contract as the spawn path (#144): a failed final turn is an
          // error, not a completion — but the resumed text stays available.
          // Resume runs never abort/steer (the runner reports text+failure
          // only), so those inputs are fixed false here.
          const resumeDecision = reduceSettle({
            kind: "resolved",
            stopped: isExternallyStopped(),
            aborted: false,
            steered: false,
            failure,
          });
          record.status = resumeDecision.status;
          if (resumeDecision.error !== undefined) record.error = resumeDecision.error;
        }
        record.result = text;
        record.completedAt = Date.now();
      } catch (err) {
        // Stale generation (see above): hands off, new run owns it.
        if (record.epoch !== epoch) return "";
        const resumeDecision = reduceSettle({
          kind: "rejected",
          stopped: isExternallyStopped(),
          error: err instanceof Error ? err.message : String(err),
          keepErrorWhenStopped: false,
        });
        record.status = resumeDecision.status;
        if (resumeDecision.error !== undefined) record.error = resumeDecision.error;
        record.completedAt = Date.now();
      } finally {
        detachCallerSignal?.();
      }
      return "";
    })();
    // Generation at await time: a newer resume meanwhile replaced the promise
    // and owns the record — its tail (not this one) aborts children.
    const awaitedEpoch = record.epoch;
    await record.promise;

    // Same contract as the spawn settle paths: children spawned during the
    // resumed turn must not outlive it — nothing else can see or reach them.
    if (record.epoch === awaitedEpoch) this.abortOwnedChildren(id);

    return record;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    // New generation: any late settlement from the previous run on this
    // record must not touch the new run's status, result, lease, or children.
    record.epoch++;
    const epoch = record.epoch;
    // Same no-budget rule as the foreground path: continuations run open.
    this.disarmRunTimeout(record);
    record.timeoutMs = undefined;
    record.timeoutFired = undefined;
    // Orphaned lease, same as the foreground path: freed here because the
    // old settle is epoch-barred from touching it. The acquire below then
    // counts exactly the new run's slot.
    if (record.slotLease !== undefined) {
      this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
      record.slotLease = undefined;
    }
    record.status = "running";
    record.startedAt = Date.now();
    // Resumes re-enter the pool like fresh starts (same lease discipline).
    // Background-only, exactly as before: foreground resumes never held a
    // slot, so poolFor's foreground branch must not apply here.
    if (occupiesPoolSlot(record)) {
      const acquired = acquireSlot(this.poolLedger, "background", true);
      // Unconditional: a resume restarts work that already held a slot in a
      // past life — like the bypass path, it counts even past the cap.
      if (acquired !== undefined) {
        this.poolLedger = acquired.ledger;
        record.slotLease = acquired.lease;
      }
    }
    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    const settle = () => {
      // Stale generation: a newer resume owns the record — its lease,
      // children, and completion belong to it, not to this run.
      if (record.epoch !== epoch) return;
      detachParentSignal?.();
      detachParentSignal = undefined;
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      if (record.slotLease !== undefined) {
        this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
        record.slotLease = undefined;
      }
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    };

    const promise = resumeAgent(record.session, prompt, {
      onToolActivity: (activity) => {
        trackToolActivity(record, activity);
        options.onToolActivity?.(activity);
      },
      onToolOutput: (delta) => {
        pushLiveOutput(record, delta);
        touchOutput(record);
      },
      onThinkingActivity: (phase) => {
        // Reasoning deltas prove work through a stretch with no tool calls
        // and no text — without this, a long think flags as stalled.
        // Heartbeat only: thinking is not judge-visible output.
        if (phase === "end") record.reasoningSince = undefined;
        else if (record.reasoningSince === undefined) record.reasoningSince = Date.now();
        touchActivity(record);
      },
      onAssistantUsage: (usage) => {
        // Heartbeat like every other resume path: usage without text or
        // tools is still proof of life (empty/error turns carry usage).
        touchActivity(record);
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
      .then(({ text, failure }) => {
        // Resume runs report text+failure only: no aborted/steered inputs.
        const resumeDecision = reduceSettle({
          kind: "resolved",
          stopped: record.status === "stopped",
          aborted: false,
          steered: false,
          failure,
        });
        record.status = resumeDecision.status;
        if (resumeDecision.error !== undefined) record.error = resumeDecision.error;
        record.result = text;
        record.completedAt ??= Date.now();
        settle();
        return text;
      })
      .catch((err) => {
        const resumeDecision = reduceSettle({
          kind: "rejected",
          stopped: record.status === "stopped",
          error: err instanceof Error ? err.message : String(err),
          keepErrorWhenStopped: false,
        });
        record.status = resumeDecision.status;
        if (resumeDecision.error !== undefined) record.error = resumeDecision.error;
        record.completedAt ??= Date.now();
        settle();
        return "";
      });

    record.promise = promise;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued" || record.status === "provisioning") {
        return { kind: "live", record };
      }
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    // The queued-abort listener served its purpose (or never will): drop it
    // here rather than letting it fire late onto a settled record's id.
    this.detachQueuedAbort(record);

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      // A steer can never land here — the tool refuses non-running agents —
      // but drop the queue anyway so a late session creation cannot flush
      // guidance into an agent that was stopped before it started.
      record.pendingSteers = undefined;
      try {
        this.onStop?.(record);
      } catch { /* a listener must never break the stop itself */ }
      return true;
    }

    if (record.status !== "running" && record.status !== "provisioning") return false;
    record.abortController?.abort();
    // Provisioning runs never kicked off, so no settle is coming to free the
    // slot — release the lease here. Running runs settle normally (settleRun
    // frees), so only the provisioning branch touches the lease.
    if (record.status === "provisioning" && record.slotLease !== undefined) {
      this.poolLedger = releaseLedgerSlot(this.poolLedger, record.slotLease);
      record.slotLease = undefined;
    }
    record.status = "stopped";
    record.completedAt = Date.now();
    // Same guard as above, for the wider window: steering a stopped agent is
    // meaningless, and without this a session created after the stop would
    // still flush queued steers into it via onSessionCreated.
    record.pendingSteers = undefined;
    // Guarded like onComplete/onStall: abort() routes abortAll() and the
    // stall sweep, so a throwing listener here would skip remaining aborts
    // or break the sweep mid-iteration — the stop must be total.
    try {
      this.onStop?.(record);
    } catch { /* a listener must never break the stop itself */ }
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.detachQueuedAbort(record);
    // Eviction must not leave a timer that later aborts a recycled id.
    this.disarmRunTimeout(record);
    this.tombstone(record);
    // Last chance to finalize the output transcript: eviction skips every
    // settle path, and without this the file handle pins until process end.
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // A failed startup keeps its (rejected) entry so a late awaitStartup still
    // sees it; drop it with the record so the map can't grow unbounded.
    this.startups.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has both a handle to be
   * addressed by and a session file to reopen — an in-memory session leaves no
   * transcript, so the mention would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    });
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  /** Stall silence threshold. Injectable for tests; production default is the shared 10 minutes. */
  private stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
  /** Abort running agents silent past the threshold. Default off (see settings). */
  private stallAutoAbort = false;

  /**
   * Override the stall threshold. Deliberately unclamped: tests inject
   * millisecond thresholds, while user-facing values pass through the
   * settings loader's [1min, 24h] clamp first. Do not "unify" the two —
   * the raw setter is a seam, the clamp is policy.
   */
  setStallThresholdMs(ms: number) {
    this.stallThresholdMs = Math.max(1, ms);
  }

  /** Opt into aborting stalled runners. Default off. */
  setStallAutoAbort(b: boolean) {
    this.stallAutoAbort = b;
  }

  /** Current auto-abort arming (settings menu display). */
  isStallAutoAbort(): boolean {
    return this.stallAutoAbort;
  }

  /**
   * Snooze a running agent for `minutes`: forgive the current silence episode,
   * suppress re-flagging until the window lapses, and push any run deadline
   * out by the same window. The judge's "give it more time" —
   * side-effect-free towards the agent itself (unlike steering, it sends
   * nothing into the run). Heartbeat, flag clear, snoozedUntil, deadline:
   * deliberately NOT lastOutputAt (that would fabricate output evidence),
   * and never arming a deadline on an unlimited run.
   * Returns false when there is nothing to snooze (missing, non-running, or
   * settled record).
   */
  snooze(id: string, minutes: number): boolean {
    const record = this.agents.get(id);
    if (!record || record.status !== "running") return false;
    const now = Date.now();
    const windowMs = Math.max(1, minutes) * 60_000;
    record.lastActivityAt = now;
    record.stalledSince = undefined;
    record.snoozedUntil = now + windowMs;
    if (record.timeoutMs !== undefined && record.timeoutMs > 0) {
      // Push the deadline out from NOW (not from the original start): the
      // judge grants fresh time, and the timer re-arms for exactly it.
      record.timeoutMs = now - record.startedAt + windowMs;
      record.timeoutFired = undefined;
      this.armRunTimeout(id, record);
    }
    return true;
  }

  /** Current stall threshold (settings snapshot). */
  getStallThresholdMs(): number {
    return this.stallThresholdMs;
  }

  /**
   * Arm the per-run wall-clock budget. Called at kickoff and on snooze
   * re-arm. `timeoutMs` is total-from-start; the delay is the remainder —
   * so queued time never counts (armed at kickoff, not spawn) and snooze
   * recomputes the total and re-arms for exactly the fresh window.
   * The timer captures the run's epoch: a stale generation firing late
   * (abort→resume→timer-fires) resolves to a no-op instead of killing
   * the new run. Unref'd: a budget must never hold the process open.
   */
  private armRunTimeout(id: string, record: AgentRecord): void {
    this.disarmRunTimeout(record);
    const budget = record.timeoutMs ?? 0;
    if (budget <= 0) return;
    const remaining = budget - (Date.now() - record.startedAt);
    if (remaining <= 0) {
      // Already exceeded (tiny test budgets, long queue tail): expire on the
      // next tick rather than aborting synchronously inside the caller.
      const timer = setTimeout(() => this.expireRunTimeout(id, record, record.epoch), 0);
      timer.unref?.();
      record.timeoutTimer = timer;
      return;
    }
    const epoch = record.epoch;
    const timer = setTimeout(() => this.expireRunTimeout(id, record, epoch), Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref?.();
    record.timeoutTimer = timer;
  }

  /** Budget timer body: epoch- and liveness-checked abort. */
  private expireRunTimeout(id: string, record: AgentRecord, epoch: number): void {
    record.timeoutTimer = undefined;
    if (record.epoch !== epoch) return;
    const live = this.agents.get(id);
    if (live !== record || record.status !== "running") return;
    record.timeoutFired = true;
    this.abort(id);
  }

  /** Clear a budget timer. Idempotent; safe on records that never armed. */
  private disarmRunTimeout(record: AgentRecord): void {
    if (record.timeoutTimer !== undefined) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = undefined;
    }
  }

  private cleanup() {
    const now = Date.now();
    const cutoff = now - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") {
        this.sweepStall(id, record, now);
        continue;
      }
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Flag one silent runner and notify once per episode. Public for tests;
   * production calls it from the 60s cleanup sweep. Any heartbeat clears
   * stalledSince, which re-arms the next episode — no throttle bookkeeping.
   *
   * With auto-abort armed (opt-in, running records only — queued silence is
   * waiting, never wedging), the abort follows the nudge in the same sweep
   * through the normal stop path, so the STOPPED note + notification carry
   * the story. Queued records are flagged for visibility but never aborted.
   */
  sweepStall(id: string, record: AgentRecord, now = Date.now()) {
    if (record.stalledSince !== undefined) return;
    if (!isStalled(record, now, this.stallThresholdMs)) return;
    record.stalledSince = now;
    record.stallEpisodes = (record.stallEpisodes ?? 0) + 1;
    try {
      this.onStall?.(record);
    } catch { /* ignore stall side-effect errors */ }
    // Re-read after the callback: it runs host code that may have snoozed
    // the record, settled it, or otherwise changed what we checked above.
    // An abort decided on stale state could kill a run the callback just
    // saved — the exact hazard snooze exists to prevent.
    // Top-level only — the same ownership boundary stop_subagent enforces.
    // Nested children belong to their parent agent, workflow children to
    // their run (which has its own budget + skip/retry controls); killing
    // either from a global sweep would break a plan the sweeper cannot see.
    if (
      this.stallAutoAbort
      && record.status === "running"
      && record.stalledSince !== undefined
      && isTopLevelAgent(record)
      && isStalled(record, now, this.stallThresholdMs)
    ) {
      try {
        this.abort(id);
      } catch { /* sweep must never die on one record */ }
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || record.status === "provisioning") {
        continue;
      }
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued" || r.status === "provisioning",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    // Route through abort() so every stop shares one state machine (status,
    // pending steers, stop event): collect ids first, abort() mutates the queue.
    const ids = [
      ...this.queue.map(q => q.id),
      ...[...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "provisioning")
        .map(r => r.id),
    ];
    let count = 0;
    for (const id of ids) if (this.abort(id)) count++;
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (
          record.status !== "running"
          && record.status !== "queued"
          && record.status !== "provisioning"
        ) {
          continue;
        }
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    const cleanup: Promise<unknown>[] = sessions.map(session => shutdownChildSession(session));
    if (pi) {
      // Prune orphaned registrations concurrently with child shutdown. A cwd that
      // is not a repository is an expected no-op; pruneWorktrees validates it
      // silently so diagnostics never write through Pi's alternate-screen TUI.
      const repos = new Set([process.cwd(), ...this.worktreeRepos]);
      cleanup.push(...[...repos].map(repo => pruneWorktrees(pi, repo)));
    }
    // Pi awaits session_shutdown, so every bounded cleanup operation must be
    // included here rather than detached and allowed to race process exit.
    await Promise.allSettled(cleanup);
  }
}
