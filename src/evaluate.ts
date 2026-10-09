// Layer 3, evaluate (deterministic): runs sql/checks/*.sql against the snapshot -> findings.
//
// Each check returns org, repo, check_id, status, evidence (JSON) and remediation. This module
// adds run_id, severity (from config) and observed_at, validates every row against the findings
// schema, and writes the findings to runs/<run_id>.json.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { RUNS, dbPath } from "./snapshot.ts";
import { Finding, Manifest } from "./types.ts";
import { CORE_CHECKS, Selection, select, selected } from "./selection.ts";

// module relative so the CLI works from any directory; runs/ stays relative to the caller
const CHECKS = fileURLToPath(new URL("../sql/checks", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../policy/manifest.json", import.meta.url));

export interface Run {
  run_id: string;
  observed_at: string;
}

export interface Evaluation extends Run {
  findings: Finding[];
  selection?: Selection;
}

export const checkIds = (): string[] =>
  readdirSync(CHECKS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => basename(f, ".sql"));

/** Every check with its description, the leading comment of its SQL. */
export const checks = (): { id: string; description: string }[] =>
  checkIds().map((id) => {
    const sql = readFileSync(join(CHECKS, `${id}.sql`), "utf8");
    const comment = sql.split("\n").filter((line) => line.startsWith("--"));
    const text = comment.map((line) => line.replace(/^--\s?/, "")).join(" ");
    return { id, description: text.replace(`${id}: `, "") };
  });

/** Newest run in runs/. ULIDs sort by time. */
export function latestRun(): string {
  const ids = existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith(".db")) : [];
  const latest = ids.sort().at(-1);
  if (!latest) throw new Error("no snapshot in runs/, run `code-estate-warden snapshot` first");
  return basename(latest, ".db");
}

export const findingsPath = (runId: string) => posix.join(RUNS, `${runId}.json`);

/** Run one check against an open snapshot. Rows that do not fit the findings schema throw. */
export function runCheck(db: DatabaseSync, checkId: string, run: Run, config: Config): Finding[] {
  for (const sql of readFileSync(join(CHECKS, "..", "compat.sql"), "utf8").split(";")) {
    const table = /CREATE TEMP TABLE IF NOT EXISTS (\w+)/.exec(sql)?.[1];
    if (table && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.exec(sql);
  }
  const sql = readFileSync(join(CHECKS, `${checkId}.sql`), "utf8");
  const severity = config.severity[checkId] ?? "medium";
  return db.prepare(sql).all().map((row) =>
    Finding.parse({
      ...row,
      ...run,
      severity,
      evidence: JSON.parse(String(row.evidence)),
      remediation: row.status === "fail" ? row.remediation : "none",
    }),
  );
}

/** The compiled policy, if one has been written. Without it every check runs and nothing is exempt. */
export const loadManifest = (): Manifest | undefined =>
  existsSync(MANIFEST) ? Manifest.parse(JSON.parse(readFileSync(MANIFEST, "utf8"))) : undefined;

export const saveManifest = (manifest: Manifest): void =>
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

type RepoFacts = { private: number; fork: number };

/** A finding the policy exempts becomes na, with the reason in its evidence. */
function exempt(f: Finding, manifest: Manifest, facts?: RepoFacts): Finding {
  const rule = manifest.checks.find((c) => c.id === f.check_id);
  if (!rule || f.repo === "*" || f.status === "na" || !facts) return f;
  const reason =
    (rule.scope === "public" && facts.private && "private repository") ||
    (rule.exempt_forks && facts.fork && "fork") ||
    (rule.exempt.includes(`${f.org}/${f.repo}`) && "listed in policy") ||
    undefined;
  if (!reason) return f;
  return { ...f, status: "na", remediation: "none", evidence: { ...f.evidence, exempt: reason } };
}

/** Evaluate a run. The manifest defaults to the compiled policy on disk; null means no policy. */
export function evaluate(config: Config, runId = latestRun(), manifest: Manifest | null = loadManifest() ?? null, input: Selection = {}): Evaluation {
  if (!existsSync(dbPath(runId))) throw new Error(`no snapshot ${dbPath(runId)}`);
  const db = new DatabaseSync(dbPath(runId), { readOnly: true });
  let evaluation: Evaluation;
  let scope: Selection;
  try {
    const stored = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'selection'").get()
      ? Selection.parse(JSON.parse(String(db.prepare("SELECT scope FROM selection").get()?.scope))) : {};
    if (stored.repo && input.repo && select(config, input).repo?.toLowerCase() !== stored.repo.toLowerCase()) {
      throw new Error(`snapshot ${runId} is limited to ${stored.repo}`);
    }
    scope = select(config, { ...stored, ...input });
    const { finished_at } = db.prepare("SELECT finished_at FROM run").get() as { finished_at: string };
    const run = { run_id: runId, observed_at: finished_at };
    const excluded = new Set(config.exclude_repos.map((r) => r.toLowerCase()));
    const inScope = new Set(manifest?.checks.map((c) => c.id) ?? checkIds());
    if (scope.core) for (const id of CORE_CHECKS) inScope.add(id);
    const facts = new Map(
      (db.prepare("SELECT org, name, private, fork FROM repos").all() as (RepoFacts & { org: string; name: string })[])
        .map((r) => [`${r.org}/${r.name}`, r]),
    );
    if (scope.repo && ![...facts.keys()].some((name) => name.toLowerCase() === scope.repo!.toLowerCase())) {
      throw new Error(`${scope.repo} is not in snapshot ${runId}; take a fresh snapshot with --repo`);
    }
    const findings = checkIds()
      .filter((id) => inScope.has(id))
      .flatMap((id) => runCheck(db, id, run, config))
      .filter((f) => config.orgs.some((org) => org.toLowerCase() === f.org.toLowerCase()))
      .filter((f) => !excluded.has(`${f.org}/${f.repo}`.toLowerCase()))
      .map((f) => (manifest ? exempt(f, manifest, facts.get(`${f.org}/${f.repo}`)) : f));
    evaluation = { ...run, findings };
  } finally {
    db.close();
  }
  writeFileSync(findingsPath(runId), JSON.stringify(evaluation, null, 1));
  return Object.keys(scope).length ? { ...evaluation, selection: scope, findings: evaluation.findings.filter((f) => selected(f, scope)) } : evaluation;
}

/** The evaluation before the given run, if any, for drift. */
export function previousEvaluation(runId: string): Evaluation | undefined {
  const previous = readdirSync(RUNS)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".plan.json") && f < `${runId}.json`)
    .sort()
    .at(-1);
  return previous ? JSON.parse(readFileSync(posix.join(RUNS, previous), "utf8")) : undefined;
}
