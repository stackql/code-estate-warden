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
import { Finding } from "./types.ts";

// module relative so the CLI works from any directory; runs/ stays relative to the caller
const CHECKS = fileURLToPath(new URL("../sql/checks", import.meta.url));

export interface Run {
  run_id: string;
  observed_at: string;
}

export interface Evaluation extends Run {
  findings: Finding[];
}

export const checkIds = (): string[] =>
  readdirSync(CHECKS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => basename(f, ".sql"));

/** Newest run in runs/. ULIDs sort by time. */
export function latestRun(): string {
  const ids = existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith(".db")) : [];
  const latest = ids.sort().at(-1);
  if (!latest) throw new Error("no snapshot in runs/, run `repo-warden snapshot` first");
  return basename(latest, ".db");
}

export const findingsPath = (runId: string) => posix.join(RUNS, `${runId}.json`);

/** Run one check against an open snapshot. Rows that do not fit the findings schema throw. */
export function runCheck(db: DatabaseSync, checkId: string, run: Run, config: Config): Finding[] {
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

export function evaluate(config: Config, runId = latestRun()): Evaluation {
  if (!existsSync(dbPath(runId))) throw new Error(`no snapshot ${dbPath(runId)}`);
  const db = new DatabaseSync(dbPath(runId), { readOnly: true });
  const { finished_at } = db.prepare("SELECT finished_at FROM run").get() as { finished_at: string };
  const run = { run_id: runId, observed_at: finished_at };
  const excluded = new Set(config.exclude_repos.map((r) => r.toLowerCase()));
  const findings = checkIds()
    .flatMap((id) => runCheck(db, id, run, config))
    .filter((f) => !excluded.has(`${f.org}/${f.repo}`.toLowerCase()));
  db.close();
  const evaluation = { ...run, findings };
  writeFileSync(findingsPath(runId), JSON.stringify(evaluation, null, 1));
  return evaluation;
}

/** The evaluation before the given run, if any, for drift. */
export function previousEvaluation(runId: string): Evaluation | undefined {
  const previous = readdirSync(RUNS)
    .filter((f) => f.endsWith(".json") && f < `${runId}.json`)
    .sort()
    .at(-1);
  return previous ? JSON.parse(readFileSync(posix.join(RUNS, previous), "utf8")) : undefined;
}
