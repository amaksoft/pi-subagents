/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /**
   * Whether changes were found in the worktree. True on any cleanup failure:
   * "no changes" means verified-clean, never "cleanup gave up" — the copy
   * is preserved in that case (see path) so work is never silently lost.
   */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
  /** Which step failed, when hasChanges is true without a branch. */
  error?: string;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
): Promise<WorktreeInfo | undefined> {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    baseSha = await git(pi, cwd, ["rev-parse", "HEAD"], 5000);
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    await git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000);
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  // Step label for the catch below: the error must name WHERE cleanup
  // failed, not just repeat git's stderr ("boom" explains nothing).
  let step = "status";
  try {
    // Check for uncommitted changes in the worktree
    const status = await git(pi, worktree.path, ["status", "--porcelain"], 10000);

    if (status) {
      // Changes exist — stage, commit, and create a branch
      step = "add";
      await git(pi, worktree.path, ["add", "-A"], 10000);
      // Truncate description for commit message (no shell sanitization needed — pi.exec uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      step = "commit";
      await git(pi, worktree.path, ["commit", "--no-verify", "-m", commitMsg], 10000);
    } else {
      step = "rev-parse";
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        step = "remove";
        const removalError = await removeWorktree(pi, cwd, worktree.path);
        if (removalError) return { hasChanges: true, path: worktree.path, error: `remove: ${removalError}` };
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    step = "branch";
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree (branch persists in main repo). If removal fails,
    // retain the valid branch in the structured result while also naming the
    // preserved worktree path and cleanup error.
    const removalError = await removeWorktree(pi, cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
      ...(removalError ? { error: `remove: ${removalError}` } : {}),
    };
  } catch (err) {
    // Never report clean on failure, and never remove what we could not
    // verify: the copy stays on disk for recovery, and the error names the
    // step so the parent can say where the work is, not just that it failed.
    const detail = err instanceof Error ? err.message : String(err);
    const error = `${step}: ${detail}`;
    return { hasChanges: true, path: worktree.path, error };
  }
}

/**
 * Force-remove a worktree.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<string | undefined> {
  try {
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
    return undefined;
  } catch (removeErr) {
    // A failed remove can leave only a stale registration. Prune it without
    // writing to stdout/stderr: raw console output corrupts Pi's live TUI.
    const removeDetail = removeErr instanceof Error ? removeErr.message : String(removeErr);
    try {
      await git(pi, cwd, ["worktree", "prune"], 5000);
      return `worktree remove failed: ${removeDetail}; stale registration was pruned but ${worktreePath} may remain`;
    } catch (pruneErr) {
      const pruneDetail = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
      return `worktree remove failed: ${removeDetail}; prune failed: ${pruneDetail}`;
    }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    // `dispose()` may run from a non-repository cwd (for example a home
    // directory or a remote host path). That is an expected no-op, not a
    // warning. Resolve the repository first so git's diagnostic can never be
    // written directly into Pi's alternate-screen TUI.
    const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000);
    if (!root) return;
    await git(pi, root, ["worktree", "prune"], 5000);
  } catch {
    // Crash-recovery pruning is best effort. Cleanup failures for an actual
    // agent worktree are returned through WorktreeCleanupResult instead.
  }
}
