// Layer 1, inventory (deterministic): runs sql/snapshot/*.sql and stores the rows in runs/<run_id>.db.
//
// StackQL runs each query with its in memory backend and hands back rows; this module writes them
// with node:sqlite into one table per source in a fresh file per run. A source with an {{org}}
// placeholder runs once per org, so progress is logged per org and a pool caps the number of
// stackql processes, which is what GitHub's secondary rate limit responds to.

import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { select, type Selection } from "./selection.ts";
import { alerts } from "./dependabot.ts";
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

/** A targeted inventory uses the single-repository endpoint, not an organization-wide join. */
export function sourceQuery(sql: string, name: string, org: string | null, repo?: string): string {
  const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
  let query = sql.replaceAll("{{org}}", org ? lit(org) : "");
  if (!repo || !org || (name !== "repos" && !name.startsWith("repo_"))) return query;
  if (name === "repos") {
    return query.replace("SELECT org,", `SELECT ${lit(org)} AS org,`)
      .replace("FROM github.repos.repos", "FROM github.repos.details")
      .replace(`WHERE org = ${lit(org)}`, `WHERE owner = ${lit(org)} AND repo = ${lit(repo)}`);
  }
  return query.replace("SELECT r.org,", `SELECT ${lit(org)} AS org,`)
    .replace("FROM github.repos.repos r", "FROM github.repos.details r")
    .replace(`WHERE r.org = ${lit(org)}`, `WHERE r.owner = ${lit(org)} AND r.repo = ${lit(repo)}`)
    .replaceAll("r.org", lit(org));
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
  const workers = await Promise.allSettled(Array.from({ length: Math.min(size, tasks.length) }, worker));
  const failure = workers.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

export async function snapshot(config: Config, log = console.log, input: Selection = {}): Promise<Snapshot> {
  const scope = select(config, input);
  const orgsInScope = scope.org ? [scope.org] : config.orgs;
  const run_id = ulid();
  const db = dbPath(run_id);
  const started_at = new Date().toISOString();
  mkdirSync(RUNS, { recursive: true });
  const conn = new DatabaseSync(db);
  const files = readdirSync(SOURCES).filter((f) => f.endsWith(".sql")).sort();
  let complete = false;
  try {
    const logSource = (source: Source) =>
      log(`  ${source.name.padEnd(36)} ${(source.org ?? "").padEnd(18)} ${String(source.rows).padStart(5)} rows ${(source.ms / 1000).toFixed(1).padStart(7)}s`);
    const tasks = (names: string[]) =>
      names.flatMap((file) => {
        const sql = readFileSync(join(SOURCES, file), "utf8");
        const name = basename(file, ".sql");
        const cols = columns(sql);
        const scoped = sql.includes("{{org}}");
        const orgs = scoped ? orgsInScope : [null];
        return orgs.map((org) => async (): Promise<Source> => {
          const start = Date.now();
          const target = scope.repo?.split("/")[1];
          const output = await stackql.run(sourceQuery(sql, name, org, target));
          const rows = stackql.rows(output);
          if (target && target !== ".github" && name === "repo_security_md") {
            const inherited = await stackql.run(sourceQuery(sql, name, org, ".github"));
            const missing = !inherited.stdout && Object.keys(countErrors(inherited.stderr)).every((status) => status === "404") && inherited.stderr.includes("404");
            if (!missing) rows.push(...stackql.rows(inherited));
            output.stderr += `\n${inherited.stderr}`;
          }
          insert(conn, name, cols, rows);
          const source = { name, org, rows: rows.length, ms: Date.now() - start, errors: countErrors(output.stderr) };
          logSource(source);
          return source;
        });
      });

    // Org sources first, so the repo count is known before per-repo fan out.
    const repoLevel = files.filter((f) => f.startsWith("repo_"));
    const sources = await pool(tasks(files.filter((f) => !repoLevel.includes(f))), POOL);
    const repos = Number((conn.prepare("SELECT count(*) AS n FROM repos").get() as { n: number }).n);
    if (scope.repo && repos !== 1) throw new Error(`repository ${scope.repo} was not found or is not accessible`);
    if (scope.repo) {
      const row = conn.prepare("SELECT full_name FROM repos").get();
      if (String(row?.full_name).toLowerCase() !== scope.repo.toLowerCase()) {
        throw new Error(`${scope.repo}: repository identity changed or could not be confirmed`);
      }
    }
    await respectRateLimit(repos * (repoLevel.length + 1));
    sources.push(...(await pool(tasks(repoLevel), POOL)));
    insert(conn, "repo_dependabot_alerts", ["org", "repo", "enabled", "http_status", "reason"], []);
    const active = conn.prepare("SELECT org, name, permissions FROM repos WHERE archived = 0").all() as { org: string; name: string; permissions: string | null }[];
    const collected = await pool(active.map(({ org, name, permissions }) => async () => {
      const start = Date.now();
      const row = await alerts(org, name, JSON.parse(permissions ?? "{}")?.admin === true);
      insert(conn, "repo_dependabot_alerts", ["org", "repo", "enabled", "http_status", "reason"], [{ org, repo: name, ...row }]);
      return { org, row, ms: Date.now() - start };
    }), POOL);
    for (const org of orgsInScope) {
      const results = collected.filter((result) => result.org === org);
      const errors: Record<string, number> = {};
      for (const { row } of results) {
        if (row.enabled === null) errors[row.http_status] = (errors[row.http_status] ?? 0) + 1;
      }
      const source = { name: "repo_dependabot_alerts", org, rows: results.length, ms: results.reduce((sum, result) => sum + result.ms, 0), errors };
      sources.push(source);
      logSource(source);
    }

    conn.exec(`
      CREATE TABLE run (run_id TEXT, started_at TEXT, finished_at TEXT, enterprise TEXT, orgs TEXT,
        stackql_version TEXT, provider_version TEXT, login TEXT);
      CREATE TABLE source (name TEXT, org TEXT, rows INTEGER, ms INTEGER, errors TEXT);
      CREATE TABLE selection (scope TEXT);
    `);
    conn.prepare("INSERT INTO selection VALUES (?)").run(JSON.stringify(scope));
    const login = conn.prepare("SELECT login FROM whoami").get() as { login?: string } | undefined;
    conn
      .prepare("INSERT INTO run VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        run_id,
        started_at,
        new Date().toISOString(),
        config.enterprise,
        JSON.stringify(orgsInScope),
        (await stackql.version()) ?? null,
        await stackql.providerVersion(),
        login?.login ?? null,
      );
    const record = conn.prepare("INSERT INTO source VALUES (?, ?, ?, ?, ?)");
    for (const s of sources) record.run(s.name, s.org, s.rows, s.ms, JSON.stringify(s.errors));
    complete = true;
    return { run_id, db, repos, sources };
  } finally {
    conn.close();
    if (!complete) unlinkSync(db);
  }
}
