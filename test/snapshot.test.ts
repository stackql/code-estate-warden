import assert from "node:assert/strict";
import { Config } from "../src/config.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { evaluate } from "../src/evaluate.ts";
import { columns, dbPath, insert, snapshot, sourceQuery, ulid } from "../src/snapshot.ts";
import { http } from "../src/dependabot.ts";
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
  process.env[stackql.READ_TOKEN_VAR] = "read";
  mock.method(http, "fetch", async () => new Response(null, { status: 204 }));
});

after(() => {
  process.chdir(cwd);
  mock.restoreAll();
  delete process.env[stackql.READ_TOKEN_VAR];
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
  assert.deepEqual([...new Set(result.sources.map((s) => s.name))].sort(), [...files, "repo_dependabot_alerts"].sort());
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
  assert.deepEqual(tables.map((t) => t.name), [...files, "repo_dependabot_alerts", "run", "selection", "source"].sort());
  const repos = db.prepare("SELECT org, archived FROM repos ORDER BY org, archived").all();
  assert.deepEqual(repos.map((r) => [r.org, r.archived]), [["acme", 0], ["acme", 1], ["acme-labs", 0], ["acme-labs", 1]]);
  db.close();
});

test("targeted source queries use the repository endpoint and keep joins scoped", () => {
  assert.equal(sourceQuery("SELECT org, name FROM github.repos.repos WHERE org = {{org}}", "repos", "acme", "one"),
    "SELECT 'acme' AS org, name FROM github.repos.details WHERE owner = 'acme' AND repo = 'one'");
  const sql = "SELECT r.org, r.name AS repo, b.name FROM github.repos.repos r INNER JOIN github.repos.branch b ON b.owner = r.org AND b.repo = r.name WHERE r.org = {{org}}";
  const query = sourceQuery(sql, "repo_main_branch", "acme", "one");
  assert.match(query, /FROM github.repos.details r/);
  assert.match(query, /b.owner = 'acme'/);
  assert.match(query, /WHERE r.owner = 'acme' AND r.repo = 'one'/);
  assert.doesNotMatch(query, /github.repos.repos|r\.org/);
});

test("repo snapshots collect only the target and inherited policy, and retain scope for evaluation", async () => {
  const statements: string[] = [];
  const spawn = mock.method(stackql.io, "spawn", async (file: string, args: string[]) => {
    if (args[0] === "--version" || args.at(-1) === "SHOW PROVIDERS" || args.at(-1)?.includes("rate_limit")) return fakeSpawn(file, args);
    const sql = args.at(-1)!;
    statements.push(sql);
    if (sql.includes("content_tree")) {
      return { stdout: sql.includes("r.repo = '.github'") ? JSON.stringify([{ org: "acme", repo: ".github", path: "SECURITY.md", size: "10", sha: "s" }]) : "null", stderr: "" };
    }
    return { stdout: JSON.stringify([{
      org: "acme", name: "one", full_name: "acme/one", repo: "one", archived: "false", private: "false", fork: "false",
      permissions: '{"admin":true}', default_branch: "main", login: "bot", branch: "main", protected: "false",
      required_pull_request_reviews: '{"required_approving_review_count":0}', enforce_admins: '{"enabled":false}',
      enabled: "false", paused: "false", state: "not-configured", type: "deletion", parameters: "{}",
      security_and_analysis: '{"secret_scanning":{"status":"disabled"}}',
    }]), stderr: "" };
  });
  try {
    const result = await snapshot(config, () => {}, { repo: "https://github.com/acme/one", core: true });
    assert.equal(result.repos, 1);
    assert.ok(!statements.some((sql) => sql.includes("'acme-labs'") || sql.includes("github.repos.repos")), "no estate enumeration or unrelated org reads");
    assert.equal(statements.filter((sql) => sql.includes("content_tree") && sql.includes("r.repo = '.github'")).length, 1);
    const evaluation = evaluate(config, result.run_id);
    assert.deepEqual(evaluation.selection, { org: "acme", repo: "acme/one", core: true });
    assert.equal(evaluation.findings.length, 7);
    assert.equal(evaluation.findings.find((f) => f.check_id === "security_md")?.status, "pass");
    assert.equal(evaluation.findings.find((f) => f.check_id === "security_md")?.evidence.inherited_from, "acme/.github");
    assert.throws(() => evaluate(config, result.run_id, undefined, { repo: "acme/other" }), /limited to/);
  } finally {
    spawn.mock.restore();
  }
});

test("a failed snapshot is closed and removed rather than becoming the latest run", async () => {
  const before = readdirSync("runs").sort();
  const spawn = mock.method(stackql.io, "spawn", async () => ({ stdout: "", stderr: "failed fixture query" }));
  try {
    await assert.rejects(snapshot(config, () => {}, { org: "acme" }), /failed fixture query/);
    assert.deepEqual(readdirSync("runs").sort(), before);
  } finally {
    spawn.mock.restore();
  }
});
