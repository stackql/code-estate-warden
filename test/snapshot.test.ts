import assert from "node:assert/strict";
import { Config } from "../src/config.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { columns, dbPath, insert, snapshot, ulid } from "../src/snapshot.ts";
import * as stackql from "../src/stackql.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme", "acme-labs"], exclude_repos: [], model: "m", issue_label: "l", severity: {} });
const cwd = process.cwd();
let work: string;

/** Stand in for stackql: two rows for any select, HTTP noise on stderr for per repo sources. */
const fakeSpawn = async (_file: string, args: string[]) => {
  if (args[0] === "--version") return { stdout: "stackql v0.0.0\n", stderr: "" };
  const sql = args.at(-1) ?? "";
  if (sql === "SHOW PROVIDERS") return { stdout: '[{"name":"github","version":"v1"}]', stderr: "" };
  if (sql.includes("rate_limit")) return { stdout: '[{"rate":"{\\"remaining\\":5000,\\"reset\\":0}"}]', stderr: "" };
  assert.ok(!sql.includes("{{"), "placeholders filled");
  const org = /org = '([^']+)'/.exec(sql)?.[1] ?? "";
  const rows = [{ org, login: "a", name: "x", archived: "false" }, { org, login: "b", name: "y", archived: "true" }];
  const stderr = sql.includes("INNER JOIN")
    ? "http response status code: 404, response body: {}\nhttp response status code: 422, response body: {}"
    : "";
  return { stdout: JSON.stringify(rows), stderr };
};

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
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

test("columns come from the select list, aliases first", () => {
  const sql = "-- note\nSELECT r.org, r.name AS repo, p.enabled,\n  x.type\nFROM github.repos.repos r\nINNER JOIN t x ON x.a = r.a";
  assert.deepEqual(columns(sql), ["org", "repo", "enabled", "type"]);
  assert.throws(() => columns("DELETE FROM x"), /select list/);
});

test("insert coerces stackql strings and JSON values the same way", () => {
  const db = new DatabaseSync(":memory:");
  insert(db, "t", ["a", "b", "c", "d"], [
    { a: "true", b: "false", c: "null", d: { k: 1 } },
    { a: true, b: false, c: null, d: "text" },
  ]);
  assert.deepEqual(
    db.prepare("SELECT * FROM t").all().map((r) => ({ ...r })),
    [{ a: 1, b: 0, c: null, d: '{"k":1}' }, { a: 1, b: 0, c: null, d: "text" }],
  );
});

test("snapshot runs every source per org and records the run", async () => {
  const lines: string[] = [];
  const result = await snapshot(config, (line: string) => lines.push(line));
  assert.equal(result.db, dbPath(result.run_id));
  assert.equal(result.repos, 4, "two orgs, two repos each");
  const files = readdirSync(join(cwd, "sql/snapshot")).map((f) => f.replace(".sql", ""));
  assert.deepEqual([...new Set(result.sources.map((s) => s.name))].sort(), files.sort());
  assert.equal(lines.length, result.sources.length);
  const whoami = result.sources.filter((s) => s.name === "whoami");
  assert.deepEqual(whoami.map((s) => s.org), [null], "no org placeholder, runs once");
  const security = result.sources.filter((s) => s.name === "repo_security_md");
  assert.deepEqual(security.map((s) => [s.org, s.rows, s.errors]), [
    ["acme", 2, { "404": 1, "422": 1 }],
    ["acme-labs", 2, { "404": 1, "422": 1 }],
  ]);

  const db = new DatabaseSync(result.db, { readOnly: true });
  const run = db.prepare("SELECT * FROM run").get() as Record<string, unknown>;
  assert.equal(run.run_id, result.run_id);
  assert.equal(run.orgs, '["acme","acme-labs"]');
  assert.equal(run.provider_version, "v1");
  assert.equal(run.stackql_version, "stackql v0.0.0");
  assert.equal(run.login, "a");
  assert.equal((db.prepare("SELECT count(*) AS n FROM source").get() as { n: number }).n, result.sources.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(tables.map((t) => t.name), [...files, "run", "source"].sort());
  const repos = db.prepare("SELECT org, archived FROM repos ORDER BY org, archived").all();
  assert.deepEqual(repos.map((r) => [r.org, r.archived]), [["acme", 0], ["acme", 1], ["acme-labs", 0], ["acme-labs", 1]]);
  db.close();
});
