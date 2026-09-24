/**
 * team-tasks.ts — the session team's shared task list.
 *
 * One list per main session (the implicit team from teammate-tools.ts):
 * teammates create tasks, claim them, and update status, so a lead can
 * decompose and siblings can self-coordinate without routing everything
 * through the main session's turns. Shaped after Claude Code's Task* tools
 * (create/get/list/update + dependencies) but behind ONE tool with an action
 * union, like workflow_control.
 *
 * Claim semantics: taking an unowned task is free; taking one owned by a
 * sibling refuses and points at message_teammate to negotiate — stealing
 * silently would fork the work. Deleting a task others depend on refuses
 * with the dependent list.
 *
 * Durability: in-memory map authoritative (single process — children share
 * the manager), snapshotted to `<cwd>/.pi/subagent-teams/<sessionId>.json`
 * on every mutation via temp+rename, reloaded on construction. No lock:
 * concurrent pi processes on the same session are last-writer-wins on the
 * snapshot, never on the live map. A bare context (no session id) runs
 * memory-only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export type TeamTaskStatus = "pending" | "in-progress" | "completed";

export interface TeamTask {
  id: string;
  title: string;
  details?: string;
  status: TeamTaskStatus;
  /** Teammate label holding it (@handle, alias, or "main session"). */
  owner?: string;
  dependsOn: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface Snapshot {
  counter: number;
  tasks: TeamTask[];
}

export function resolveTeamStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-teams", `${sessionId}.json`);
}

/**
 * Actor label carrying lead privilege (reassign tasks, delete freely within
 * the dependency guard). Both tool closures use it for the main session;
 * teammates negotiate instead of taking. A convention this module defines —
 * not a role the host knows.
 */
export const TEAM_LEAD_LABEL = "main session";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

export class TeamTaskStore {
  private tasks = new Map<string, TeamTask>();
  private counter = 0;
  private filePath?: string;

  constructor(cwd?: string, sessionId?: string) {
    if (cwd && sessionId) {
      this.filePath = resolveTeamStorePath(cwd, sessionId);
      this.load();
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const snap = JSON.parse(readFileSync(this.filePath, "utf-8")) as Snapshot;
      this.counter = snap.counter ?? 0;
      for (const t of snap.tasks ?? []) this.tasks.set(t.id, t);
    } catch { /* corrupt snapshot reads as empty; mutations rewrite it */ }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ counter: this.counter, tasks: [...this.tasks.values()] }));
      renameSync(tmp, this.filePath);
    } catch { /* snapshot is best-effort; the live map is authoritative */ }
  }

  create(input: { title: string; details?: string; dependsOn?: string[]; owner?: string }, actor: string): TeamTask {
    const title = input.title.trim();
    if (!title) throw new Error("Title is required.");
    const dependsOn = input.dependsOn ?? [];
    for (const dep of dependsOn) {
      if (!this.tasks.has(dep)) throw new Error(`Unknown dependency: "${dep}".`);
    }
    this.counter += 1;
    const now = Date.now();
    const task: TeamTask = {
      id: `t${this.counter}`,
      title,
      details: input.details?.trim() || undefined,
      status: "pending",
      owner: input.owner?.trim() || undefined,
      dependsOn,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  list(status?: TeamTaskStatus): TeamTask[] {
    const all = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    return status ? all.filter(t => t.status === status) : all;
  }

  get(id: string): TeamTask | undefined {
    return this.tasks.get(id);
  }

  update(
    id: string,
    patch: { title?: string; details?: string; status?: TeamTaskStatus; owner?: string | null; dependsOn?: string[] },
    actor: string,
  ): TeamTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: "${id}".`);
    if (patch.owner !== undefined && patch.owner !== null) {
      const want = patch.owner.trim();
      if (want && task.owner && task.owner !== want && task.owner !== actor && actor !== TEAM_LEAD_LABEL) {
        throw new Error(`"${id}" is claimed by ${task.owner} — message_teammate to negotiate before taking it.`);
      }
      task.owner = want || undefined;
    }
    if (patch.owner === null) task.owner = undefined;
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error("Title cannot be emptied.");
      task.title = patch.title.trim();
    }
    if (patch.details !== undefined) task.details = patch.details.trim() || undefined;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.dependsOn !== undefined) {
      for (const dep of patch.dependsOn) {
        if (!this.tasks.has(dep)) throw new Error(`Unknown dependency: "${dep}".`);
        if (dep === id) throw new Error(`"${id}" cannot depend on itself.`);
      }
      task.dependsOn = patch.dependsOn;
    }
    task.updatedAt = Date.now();
    this.save();
    return task;
  }

  remove(id: string): void {
    if (!this.tasks.has(id)) throw new Error(`Unknown task: "${id}".`);
    const dependents = [...this.tasks.values()].filter(t => t.dependsOn.includes(id)).map(t => t.id);
    if (dependents.length > 0) {
      throw new Error(`"${id}" is a dependency of ${dependents.join(", ")} — update those first.`);
    }
    this.tasks.delete(id);
    this.save();
  }
}

export function formatTeamTask(t: TeamTask): string {
  const owner = t.owner ? ` · owner ${t.owner}` : "";
  const deps = t.dependsOn.length > 0 ? ` · depends on ${t.dependsOn.join(", ")}` : "";
  const details = t.details ? `\n  ${t.details.slice(0, 300)}` : "";
  return `${t.id} [${t.status}]${owner}${deps} — ${t.title}${details}`;
}

export interface TeamTasksParams {
  action: "create" | "list" | "get" | "update" | "delete";
  id?: string;
  title?: string;
  details?: string;
  status?: TeamTaskStatus;
  owner?: string;
  dependsOn?: string[];
}

/**
 * One action runner shared by both closures (main session + teammates):
 * the switch lives here once, the tools are thin shells around it.
 */
export function runTeamTasksAction(
  store: TeamTaskStore,
  actorLabel: string,
  params: TeamTasksParams,
): { content: { type: "text"; text: string }[]; isError: boolean; details: {} } {
  const run = (fn: () => string) => {
    try {
      return textResult(fn());
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  };
  switch (params.action) {
    case "create":
      if (!params.title) return textResult("create needs a title.", true);
      return run(() => {
        const t = store.create(
          { title: params.title!, details: params.details, dependsOn: params.dependsOn, owner: params.owner },
          actorLabel,
        );
        return `Created ${formatTeamTask(t)} (by ${actorLabel}).`;
      });
    case "list": {
      const tasks = store.list(params.status);
      return textResult(
        tasks.length > 0 ? tasks.map(formatTeamTask).join("\n") : "No team tasks yet — create the first with action=create.",
      );
    }
    case "get":
      if (!params.id) return textResult("get needs an id.", true);
      return run(() => {
        const t = store.get(params.id!);
        if (!t) throw new Error(`Unknown task: "${params.id}".`);
        return formatTeamTask(t);
      });
    case "update":
      if (!params.id) return textResult("update needs an id.", true);
      return run(() => {
        const t = store.update(
          params.id!,
          {
            title: params.title,
            details: params.details,
            status: params.status,
            owner: params.owner === "" ? null : params.owner,
            dependsOn: params.dependsOn,
          },
          actorLabel,
        );
        return `Updated ${formatTeamTask(t)}.`;
      });
    case "delete":
      if (!params.id) return textResult("delete needs an id.", true);
      return run(() => {
        store.remove(params.id!);
        return `Deleted ${params.id}.`;
      });
  }
}

export function createTeamTasksTools(store: TeamTaskStore, actorLabel: string): ToolDefinition[] {
  const tool = defineTool({
    name: "team_tasks",
    label: "Team Tasks",
    description:
      "The session team's shared task list — create tasks, claim them, track status, declare dependencies. " +
      "The lead decomposes here; teammates claim open work and update their own status instead of reporting every step. " +
      "Claiming a task owned by a sibling refuses: negotiate with message_teammate first (the lead may reassign).",

    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ],
        { description: "What to do." },
      ),
      id: Type.Optional(Type.String({ description: "Task id (get/update/delete)." })),
      title: Type.Optional(Type.String({ description: "Task title (create, update)." })),
      details: Type.Optional(Type.String({ description: "Longer description (create, update)." })),
      status: Type.Optional(
        Type.Union([Type.Literal("pending"), Type.Literal("in-progress"), Type.Literal("completed")], {
          description: "Filter (list) or new status (update).",
        }),
      ),
      owner: Type.Optional(
        Type.String({
          description: "Claim by label, \"\" to release (update). Claiming another's task refuses — negotiate first.",
        }),
      ),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Dependency ids (create, update)." })),
    }),
    execute: async (_toolCallId, params) => runTeamTasksAction(store, actorLabel, params as TeamTasksParams),
  });
  return [tool];
}
