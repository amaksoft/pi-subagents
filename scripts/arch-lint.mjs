#!/usr/bin/env node
/**
 * arch-lint.mjs — Phase-0 architecture enforcement for the clean-slate migration.
 *
 * The target (docs/architecture.md) puts every status transition behind pure
 * reducers and every counter behind one owner. Until the strangler gets there,
 * this lint freezes the current shape so it cannot silently get worse:
 *
 *   1. status-writes — `.status =` may only appear in the owner modules.
 *      A new write site anywhere else is a new implicit transition.
 *   2. ui-runtime — ui/ may read manager state through instances it is handed
 *      plus pure predicates and types, but must never reach into runtime
 *      internals (workflow/runtime) or manager construction.
 *   3. counters — pool slot counters are incremented/decremented in exactly
 *      one module. A second owner is how split-brain counters are born.
 *
 * Run: `npm run lint:arch` (wired into `npm run check`). Exits non-zero with
 * file:line violations. Deliberately regex-based, not AST-based: the rules it
 * enforces are about *where* code lives, which grep answers precisely.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const failures = [];
const rel = p => p.slice(ROOT.length + 1);

// 1. Status writes live in owner modules only.
const STATUS_OWNERS = new Set(["agent-manager.ts", "workflow/task.ts"]);
for (const f of files(ROOT)) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.split("//")[0];
    if (/\.status\s*=(?![=>])/.test(code) && !STATUS_OWNERS.has(rel(f))) {
      failures.push(`${rel(f)}:${i + 1}: status write outside owner modules (agent-manager.ts, workflow/task.ts)`);
    }
  });
}

// 2. ui/ reaches runtime only through handed instances, pure predicates, types.
const UI_VALUE_ALLOW = new Map([
  ["../agent-manager.js", new Set(["isTopLevelAgent"])],
]);
for (const f of files(join(ROOT, "ui"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/^import\s+([^;]+?)\s+from\s+["']([^"']+)["'];?/gm)) {
    const [, clause, mod] = m;
    if (mod !== "../agent-manager.js" && mod !== "../workflow/runtime.js") continue;
    if (/^\s*import\s+type\b/.test(m[0])) continue;
    const names = [...clause.matchAll(/(?:type\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]);
    const allowed = UI_VALUE_ALLOW.get(mod) ?? new Set();
    for (const n of names) {
      if (n === "type" || allowed.has(n)) continue;
      // `import { type X }` members are types, not values.
      if (new RegExp(`type\\s+${n}\\b`).test(clause)) continue;
      failures.push(`${rel(f)}: ui value-import '${n}' from '${mod}' (types + isTopLevelAgent only)`);
    }
  }
}

// 3. Pool counters have a single owner.
for (const f of files(ROOT)) {
  if (rel(f) === "agent-manager.ts") continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.split("//")[0];
    if (/running(Background|Foreground)\s*(\+\+|--|\+=|-=)/.test(code)) {
      failures.push(`${rel(f)}:${i + 1}: pool counter mutation outside agent-manager.ts`);
    }
  });
}

if (failures.length > 0) {
  console.error(`arch-lint: ${failures.length} violation(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("arch-lint: clean (status owners + ui boundary + counter owner hold)");
