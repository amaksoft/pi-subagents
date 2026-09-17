# Architecture North Star

Where this extension is going, and what it is deliberately not becoming.
Synthesized from a three-proposal panel (event-sourced, strict-layers+FSM,
capability-first) with maintainer critique. Winner: **strict layers + explicit
FSMs, trimmed** — pure reducers, lint-enforced boundaries, strangler migration.

## The diagnosis (why)

- **Multi-writer status**: `record.status` is written from ~18 sites in
  `agent-manager.ts` alone; no single function owns any transition.
- **Optimistic-running lie**: spawns report `running` before the worktree copy
  and session exist; every waiter special-cases running-with-no-promise.
- **Joint settle**: `runAgent` flags + manager if-ordering share the
  aborted>error>steered>completed precedence across two files.
- **UI mutates domain**: dialog/menu call task mutators directly.
- **Split-brain counters**: pool slots incremented/decremented across paths.

## Target layout

```
domain/agent/      pure lifecycle: machine + reduceAgent + reduceSettle
domain/queue/      pure admission: SlotLease, FIFO-per-pool, captured leases
domain/workflow/   pure run logic: run machine, progress selectors, budget
domain/kernel.ts   ids, epochs, Clock, Result<T>, minimal OwnerRef
app/*-service.ts   ONLY senders to machines (agent, workflow, schedule, resume)
ports/             session/worktree/journal/transcript/store/timer/notifier/config
adapters/pi|fs/    the ONLY pi-core/node-touching code
views/projector.ts immutable snapshots + one formatter + one resolve(ref)
```

Rules: no pi-core/fs/timer/worker imports under `domain/`; no `.status =`
outside reducers (see `npm run lint:arch`); UI renders snapshots and sends
Commands, never imports domain mutators.

## The three machines (build first, in this order)

- **M1 AgentLifecycle**: `PROVISIONING|QUEUED|RUNNING|SETTLING|COMPLETED|STEERED|ABORTED|ERRORED|STOPPED`.
  Spawn validates once at the boundary; running only after ports succeed;
  single `reduceSettle` owns precedence; abort is an epoch-bumped transition
  that discards stale completions.
- **M2 QueueSlot per pool**: permits as data, FIFO, captured leases (mid-run
  config changes are no-ops), settle as sole releaser.
- **M3 WorkflowRun**: `RUNNING|PAUSED|SETTLING|terminal`; skip/retry as
  intents (`SKIP_REFUSED` surfaces, never silently drops); per-label resume
  scope; pause-aware budget.

Deliberately NOT machines: budget (deadline helper), stall (derived
predicate — see status-note.ts), schedule mapping, notifications.

## Migration (strangler — order matters)

- **Phase 0 (this commit): freeze + lint.** `scripts/arch-lint.mjs` bans new
  status writes outside owners, ui→runtime value imports, and second counter
  owners. Journal digests + reader passthrough pinned as golden fixtures.
- **Phase 1**: PoolQueue + AgentLifecycle reducer beside the manager, thin
  adapter delegation, hard cutover per seam behind a flag.
- **Phase 2**: PROVISIONING state + typed StartupError (one versioned-break
  diff: FleetView, waitForAll, spawnAndWait, scheduler finalize together).
- **Phase 3**: Settle unification via runner-emitted outcomes + golden table
  tests of every flag combination before ship.
- **Phase 4**: Workflow strangler (run machine, explicit pendingSkip,
  additive per-label resume, generation-checked budget).
- **Phase 5**: UI + `index.ts` split, LAST (mostly deletion).

## Do NOT change

Tool/RPC shapes and semantics; pi-core-owned lifecycles (sessions, TUI tick,
worker threads, dispose ordering); journal bytes + transcript dirs;
progress math and retention numbers (extract, don't retune);
live-vs-next-session settings semantics; UI tick timers stay polling.

## NEVER (explicitly out of scope)

Durable event log as source of truth; projections framework; TimerGateway
owning all timers; capability taxonomy beyond minimal OwnerRef; durable
notification outbox; disk-indexed resume registry; journal reorder flag-day.

## Biggest risks (with mitigations)

- Epoch-retrofit double-apply → hard cutover per seam, no shadow dual-write.
- Settle-precedence inversion → golden table tests + coverage gate first.
- Journal replay billing blast radius → byte-identical fixtures first,
  additive changes only, versioned reader budgeted up front.
- Timer/effect ordering → deterministic concurrency harness (fake Clock,
  injected sweeps), not just pure-reducer tests.
- Rot-back → the lint bans above, enforced in review, not just CI.
