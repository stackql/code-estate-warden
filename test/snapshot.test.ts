import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { dbPath, snapshot, ulid } from "../src/snapshot.ts";
import * as stackql from "../src/stackql.ts";

const config = { enterprise: "acme", orgs: ["acme", "acme-labs"], exclude_repos: [], model: "m", issue_label: "l", severity: {} };
const cwd = process.cwd();
let work: string;

/** Stand in for stackql: creates a table per materialized view and answers the metadata queries. */
const fakeSpawn = async (_file: string, args: string[]) => {
  if (args[0] === "--version") return { stdout: "stackql v0.0.0\n", stderr: "" };
  const sql = args.at(-1) ?? "";
  const backend = args[args.indexOf("--sqlBackend") + 1];
  if (sql === "SHOW PROVIDERS") return { stdout: '[{"name":"github","version":"v1"}]', stderr: "" };
  if (sql.includes("rate_limit")) return { stdout: '[{"rate":"{\\"remaining\\":5000,\\"reset\\":0}"}]', stderr: "" };
  const name = /CREATE MATERIALIZED VIEW (\w+)/.exec(sql)?.[1];
  assert.ok(name && backend, `unexpected statement: ${sql}`);
  assert.ok(sql.includes("'acme', 'acme-labs'"), "orgs placeholder filled");
  const db = new DatabaseSync(JSON.parse(backend).dsn.replace("file:", ""));
  db.exec(`CREATE TABLE ${name} (login TEXT); INSERT INTO ${name} VALUES ('a'), ('b')`);
  db.close();
  return { stdout: "", stderr: name.startsWith("repo_") ? "http response status code: 404, response body: {}\nhttp response status code: 404, response body: {}\nhttp response status code: 422, response body: {}" : "" };
};

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
  mkdirSync(join(work, "sql/snapshot"), { recursive: true });
  for (const name of ["whoami", "repos", "repo_thing"]) {
    writeFileSync(join(work, `sql/snapshot/${name}.sql`), `CREATE MATERIALIZED VIEW ${name} AS SELECT 1 WHERE org IN ({{orgs}})`);
  }
  process.chdir(work);
  mock.method(stackql.io, "spawn", fakeSpawn);
});

after(() => {
  process.chdir(cwd);
  mock.restoreAll();
  rmSync(work, { recursive: true, force: true });
});

test("ulid is 26 Crockford characters and sorts by time", () => {
  const a = ulid(1_000_000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < ulid(2_000_000));
});

test("snapshot builds every source and records the run", async () => {
  const lines: string[] = [];
  const result = await snapshot(config, (line: string) => lines.push(line));
  assert.equal(result.db, dbPath(result.run_id));
  assert.equal(result.repos, 2);
  assert.deepEqual(result.sources.map((s) => [s.name, s.rows, s.errors]), [
    ["repos", 2, {}],
    ["whoami", 2, {}],
    ["repo_thing", 2, { "404": 2, "422": 1 }],
  ]);
  assert.equal(lines.length, 3);

  const db = new DatabaseSync(result.db, { readOnly: true });
  const run = db.prepare("SELECT * FROM run").get() as Record<string, unknown>;
  assert.equal(run.run_id, result.run_id);
  assert.equal(run.orgs, '["acme","acme-labs"]');
  assert.equal(run.provider_version, "v1");
  assert.equal(run.stackql_version, "stackql v0.0.0");
  assert.equal(run.login, "a");
  assert.equal((db.prepare("SELECT count(*) AS n FROM source").get() as { n: number }).n, 3);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(tables.map((t) => t.name), ["repo_thing", "repos", "run", "source", "whoami"]);
  db.close();
  assert.ok(!existsSync(join("runs", result.run_id)), "per source files are removed after the merge");
});
