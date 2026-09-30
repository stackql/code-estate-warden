// Layer 1, inventory (deterministic): runs sql/snapshot/*.sql to build the materialized views.
//
// Each source is collected by StackQL into its own SQLite file as a materialized view, in
// parallel, then the views are merged into one run file under runs/ with node:sqlite and the
// run metadata is added. Views are only ever created in a fresh file, never refreshed: a failed
// REFRESH leaves a view empty, PURGE drops views, and parallel stackql processes on one file
// race on provider discovery and lose statements.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import * as stackql from "./stackql.ts";

const SOURCES = fileURLToPath(new URL("../sql/snapshot", import.meta.url));
export const RUNS = "runs";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface Source {
  name: string;
  rows: number;
  ms: number;
  /** HTTP failures per status code. A failed per-repo call means an absent row, not a failed run. */
  errors: Record<string, number>;
}

export interface Snapshot {
  run_id: string;
  db: string;
  repos: number;
  sources: Source[];
}

/** ULID: 48 bits of time then 80 bits of randomness, Crockford base32, sortable by time. */
export function ulid(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const random = crypto.getRandomValues(new Uint8Array(16));
  return time + Array.from(random, (b) => CROCKFORD[b % 32]).join("");
}

export const dbPath = (runId: string) => posix.join(RUNS, `${runId}.db`);

function countErrors(stderr: string): Record<string, number> {
  const errors: Record<string, number> = {};
  for (const [, status] of stderr.matchAll(/http response status code: (\d+)/g)) {
    errors[status!] = (errors[status!] ?? 0) + 1;
  }
  return errors;
}

/** Wait for the primary rate limit window to reset when it cannot cover the calls ahead. */
async function respectRateLimit(needed: number): Promise<void> {
  const [row] = await stackql.query("SELECT rate FROM github.rate_limit.rate_limit");
  const rate = JSON.parse(String(row?.rate ?? "{}")) as { remaining?: number; reset?: number };
  if (rate.remaining === undefined || rate.reset === undefined || rate.remaining >= needed) return;
  const wait = Math.max(rate.reset * 1000 - Date.now(), 0);
  console.log(`rate limit: ${rate.remaining} left, ${needed} needed, waiting ${Math.ceil(wait / 60000)} min`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

export async function snapshot(config: Config, log = console.log): Promise<Snapshot> {
  const run_id = ulid();
  const db = dbPath(run_id);
  const parts = posix.join(RUNS, run_id);
  const started_at = new Date().toISOString();
  mkdirSync(parts, { recursive: true });
  const vars = { orgs: config.orgs.map((org) => `'${org.replaceAll("'", "''")}'`).join(", ") };
  const files = readdirSync(SOURCES).filter((f) => f.endsWith(".sql")).sort();

  const collect = async (file: string): Promise<Source> => {
    const start = Date.now();
    const name = basename(file, ".sql");
    const part = posix.join(parts, `${name}.db`);
    const { stderr } = await stackql.runFile(join(SOURCES, file), vars, { db: part });
    const conn = new DatabaseSync(part, { readOnly: true });
    const table = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (!table.get(name)) throw new Error(`${name}: view not created\n${stderr}`);
    const rows = Number((conn.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n);
    conn.close();
    const source = { name, rows, ms: Date.now() - start, errors: countErrors(stderr) };
    log(`  ${name.padEnd(36)} ${String(rows).padStart(6)} rows ${(source.ms / 1000).toFixed(1).padStart(7)}s`);
    return source;
  };

  // org level sources first, so the repo count is known before the per repo fan out
  const repoLevel = files.filter((f) => f.startsWith("repo_"));
  const sources = await Promise.all(files.filter((f) => !repoLevel.includes(f)).map(collect));
  const repos = sources.find((s) => s.name === "repos")?.rows ?? 0;
  await respectRateLimit(repos * repoLevel.length);
  sources.push(...(await Promise.all(repoLevel.map(collect))));

  // merge the views into the run file, leaving StackQL's cache tables behind
  const conn = new DatabaseSync(db);
  for (const { name } of sources) {
    conn.exec(`ATTACH '${posix.join(parts, name)}.db' AS part;
      CREATE TABLE "${name}" AS SELECT * FROM part."${name}"; DETACH part`);
  }
  rmSync(parts, { recursive: true });
  conn.exec(`
    CREATE TABLE run (run_id TEXT, started_at TEXT, finished_at TEXT, enterprise TEXT, orgs TEXT,
      stackql_version TEXT, provider_version TEXT, login TEXT);
    CREATE TABLE source (name TEXT, rows INTEGER, ms INTEGER, errors TEXT);
  `);
  const login = conn.prepare("SELECT login FROM whoami").get() as { login?: string } | undefined;
  conn
    .prepare("INSERT INTO run VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      run_id,
      started_at,
      new Date().toISOString(),
      config.enterprise,
      JSON.stringify(config.orgs),
      (await stackql.version()) ?? null,
      await stackql.providerVersion(),
      login?.login ?? null,
    );
  const insert = conn.prepare("INSERT INTO source VALUES (?, ?, ?, ?)");
  for (const s of sources) insert.run(s.name, s.rows, s.ms, JSON.stringify(s.errors));
  conn.close();
  return { run_id, db, repos, sources };
}
