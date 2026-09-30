// Layer 1, inventory (deterministic): runs sql/snapshot/*.sql and stores the rows in runs/<run_id>.db.
//
// StackQL runs each query with its in memory backend and hands back rows; this module writes them
// with node:sqlite into one table per source in a fresh file per run. A source with an {{org}}
// placeholder runs once per org, so progress is logged per org and a pool caps the number of
// stackql processes, which is what GitHub's secondary rate limit responds to.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import * as stackql from "./stackql.ts";

// module relative so the CLI works from any directory; runs/ stays relative to the caller
const SOURCES = fileURLToPath(new URL("../sql/snapshot", import.meta.url));
export const RUNS = "runs";
const POOL = 6;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface Source {
  name: string;
  org: string | null;
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

/** Output columns of a snapshot query, from its select list: the alias, else the bare column name. */
export function columns(sql: string): string[] {
  const list = /\bSELECT\s+([\s\S]+?)\s+FROM\b/i.exec(sql)?.[1];
  if (!list) throw new Error("snapshot query has no select list");
  return list.split(",").map((item) => {
    const alias = /\bAS\s+(\w+)\s*$/i.exec(item.trim())?.[1];
    return alias ?? item.trim().split(".").at(-1)!;
  });
}

/** SQLite value for a row cell. StackQL prints every value as a string; fixtures use JSON types. */
const cell = (value: unknown): string | number | null => {
  if (value === null || value === undefined || value === "null") return null;
  if (value === true || value === "true") return 1;
  if (value === false || value === "false") return 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value as string | number;
};

/** Create the table if needed and insert the rows, one value per declared column. */
export function insert(db: DatabaseSync, table: string, cols: string[], rows: Record<string, unknown>[]) {
  const quoted = cols.map((c) => `"${c}"`).join(", ");
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${quoted})`);
  const statement = db.prepare(`INSERT INTO "${table}" VALUES (${cols.map(() => "?").join(", ")})`);
  for (const row of rows) statement.run(...cols.map((c) => cell(row[c])));
}

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
  const rate = JSON.parse(row?.rate ?? "{}") as { remaining?: number; reset?: number };
  if (rate.remaining === undefined || rate.reset === undefined || rate.remaining >= needed) return;
  const wait = Math.max(rate.reset * 1000 - Date.now(), 0);
  console.log(`rate limit: ${rate.remaining} left, ${needed} needed, waiting ${Math.ceil(wait / 60000)} min`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Run tasks with at most `size` in flight, results in task order. */
async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

export async function snapshot(config: Config, log = console.log): Promise<Snapshot> {
  const run_id = ulid();
  const db = dbPath(run_id);
  const started_at = new Date().toISOString();
  mkdirSync(RUNS, { recursive: true });
  const conn = new DatabaseSync(db);
  const files = readdirSync(SOURCES).filter((f) => f.endsWith(".sql")).sort();

  // one task per org for org scoped queries, one task otherwise
  const tasks = (names: string[]) =>
    names.flatMap((file) => {
      const sql = readFileSync(join(SOURCES, file), "utf8");
      const name = basename(file, ".sql");
      const cols = columns(sql);
      const scoped = sql.includes("{{org}}");
      const orgs = scoped ? config.orgs : [null];
      return orgs.map((org) => async (): Promise<Source> => {
        const start = Date.now();
        const quoted = org ? `'${org.replaceAll("'", "''")}'` : "";
        const output = await stackql.run(sql.replaceAll("{{org}}", quoted));
        const rows = stackql.rows(output);
        insert(conn, name, cols, rows);
        const source = { name, org, rows: rows.length, ms: Date.now() - start, errors: countErrors(output.stderr) };
        log(`  ${name.padEnd(36)} ${(org ?? "").padEnd(18)} ${String(rows.length).padStart(5)} rows ${(source.ms / 1000).toFixed(1).padStart(7)}s`);
        return source;
      });
    });

  // org level sources first, so the repo count is known before the per repo fan out
  const repoLevel = files.filter((f) => f.startsWith("repo_"));
  const sources = await pool(tasks(files.filter((f) => !repoLevel.includes(f))), POOL);
  const repos = Number((conn.prepare("SELECT count(*) AS n FROM repos").get() as { n: number }).n);
  await respectRateLimit(repos * repoLevel.length);
  sources.push(...(await pool(tasks(repoLevel), POOL)));

  conn.exec(`
    CREATE TABLE run (run_id TEXT, started_at TEXT, finished_at TEXT, enterprise TEXT, orgs TEXT,
      stackql_version TEXT, provider_version TEXT, login TEXT);
    CREATE TABLE source (name TEXT, org TEXT, rows INTEGER, ms INTEGER, errors TEXT);
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
  const record = conn.prepare("INSERT INTO source VALUES (?, ?, ?, ?, ?)");
  for (const s of sources) record.run(s.name, s.org, s.rows, s.ms, JSON.stringify(s.errors));
  conn.close();
  return { run_id, db, repos, sources };
}
