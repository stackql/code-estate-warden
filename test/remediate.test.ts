import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, mock, test } from "node:test";
import { Config } from "../src/config.ts";
import { evaluate, type Evaluation } from "../src/evaluate.ts";
import { apply, loadPlan, plan, planPath, renderPlan } from "../src/remediate.ts";
import * as stackql from "../src/stackql.ts";
import { FakeRuntime } from "./fake.ts";
import { load, readFixture } from "./fixture.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme", "beta"], exclude_repos: ["beta/skip"], model: "m" });
const RUN = "01FIXTURE0000000000000000A";
const cwd = process.cwd();
let work: string;
let evaluation: Evaluation;

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
  mkdirSync(join(work, "runs"));
  load(readFixture("snapshot").tables, join(work, "runs", `${RUN}.db`)).close();
  process.chdir(work);
  evaluation = evaluate(config, RUN, null);
});

after(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  delete process.env[stackql.WRITE_TOKEN_VAR];
});

/** The agent's script: one org level setting, one pr for two repos, one manual, one refused. */
const script = [
  { tool: "propose_change", args: { action: "setting", check_id: "private_vuln_reporting", org: "acme", repos: ["*"], target: "organization security configuration", after: "private vulnerability reporting enabled", reason: "most repos fail" } },
  { tool: "propose_change", args: { action: "pr", check_id: "security_md", org: "acme", repos: ["bad"], target: "SECURITY.md", after: "SECURITY.md present", reason: "policy" } },
  { tool: "propose_change", args: { action: "issue", check_id: "default_branch_protected", org: "acme", repos: ["bad"], target: "branch protection or ruleset", after: "default branch protected", reason: "policy" } },
  { tool: "propose_change", args: { action: "manual", check_id: "org_two_factor", org: "beta", repos: ["*"], target: "2FA requirement", after: "required", reason: "owners only" } },
  { tool: "propose_change", args: { action: "setting", check_id: "secret_scanning", org: "acme", repos: ["old"], target: "secret_scanning", after: "enabled", reason: "refused, archived" } },
];

test("plan prompts once per org with failures and writes the change set", async () => {
  const runtime = new FakeRuntime({ summary: "done", left_out: ["archived repos"] }, script);
  const lines: string[] = [];
  const result = await plan(config, runtime, evaluation, (line: string) => lines.push(line));
  assert.equal(runtime.prompts.length, 2, "acme and beta both have failures");
  assert.match(runtime.prompts[0]!, /organization acme[\s\S]*- secret_scanning \(medium, remediation setting\): 1/);
  assert.match(runtime.prompts[0]!, /"name":"baseline"/);
  // the script ran for both prompts; the refused proposal added nothing, the rest are idempotent
  assert.deepEqual(result.items.map((i) => i.key), [
    "acme/*:private_vuln_reporting:setting",
    "acme/bad:security_md:pr",
    "acme/bad:default_branch_protected:issue",
    "beta/*:org_two_factor:manual",
  ]);
  assert.equal(result.summaries.acme, "done\nLeft out: archived repos");
  assert.deepEqual(loadPlan(RUN), result);
  assert.ok(existsSync(planPath(RUN)));
  const text = renderPlan(result);
  assert.match(text, /plan 01FIXTURE0000000000000000A, 4 changes/);
  assert.match(text, /pr\s+acme\s+security_md\s+SECURITY.md: SECURITY.md present\s+\[1\] bad/);
});

/** Records every stackql statement and plays the issues API: open issues per check, created on insert. */
function fakeStackql(issues: Record<string, string>) {
  const statements: string[] = [];
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1) ?? "";
    statements.push(`${args[args.indexOf("--auth") + 1]?.includes("WRITE") ? "write" : "read"}: ${sql}`);
    if (sql.includes("github.users.users")) return { stdout: '[{"login":"bot"}]', stderr: "" };
    if (sql.startsWith("SELECT enabled")) return { stdout: '[{"enabled":"true"}]', stderr: "" };
    if (sql.startsWith("SELECT number")) {
      const rows = Object.entries(issues).map(([check, number]) => ({ number, title: `[code-estate-warden] ${check}: x` }));
      return { stdout: rows.length ? JSON.stringify(rows) : "null", stderr: "" };
    }
    if (sql.startsWith("INSERT INTO github.issues.issues")) {
      issues[/\] (\w+):/.exec(sql)?.[1] ?? "?"] = String(7 + Object.keys(issues).length);
      return { stdout: "", stderr: "insert completed" };
    }
    return { stdout: "", stderr: "The operation was despatched successfully" };
  });
  return statements;
}

test("apply is a dry run by default and needs the write token to change anything", async () => {
  const statements = fakeStackql({});
  const lines: string[] = [];
  const outcomes = await apply(config, loadPlan(RUN), evaluation, { apply: false, assignCopilot: false }, (l: string) => lines.push(l));
  assert.deepEqual(outcomes.map((o) => [o.key, o.result, o.note]), [
    ["acme/bad:private_vuln_reporting:setting", "planned", undefined],
    ["acme/bad:security_md:pr", "planned", undefined],
    ["acme/bad:default_branch_protected:issue", "planned", undefined],
    ["beta/*:org_two_factor:manual", "skipped", "manual"],
  ]);
  assert.equal(statements.length, 0, "a dry run spawns nothing");
  await assert.rejects(apply(config, loadPlan(RUN), evaluation, { apply: true, assignCopilot: false }), /CODE_ESTATE_WARDEN_WRITE_TOKEN is not set/);
});

test("apply mutates, confirms with a read, upserts issues, assigns copilot and audits", async () => {
  process.env[stackql.WRITE_TOKEN_VAR] = "token";
  const statements = fakeStackql({});
  const outcomes = await apply(config, loadPlan(RUN), evaluation, { apply: true, assignCopilot: true }, () => {});
  assert.deepEqual(outcomes.map((o) => [o.key, o.result]), [
    ["acme/bad:private_vuln_reporting:setting", "applied"],
    ["acme/bad:security_md:pr", "applied"],
    ["acme/bad:default_branch_protected:issue", "applied"],
    ["beta/*:org_two_factor:manual", "skipped"],
  ]);
  assert.match(statements[0]!, /^write: SELECT login FROM github.users.users/, "the write token identifies itself");
  assert.match(statements[1]!, /^write: EXEC github.repos.private_vulnerability_reporting.enable_private_vulnerability_reporting @owner = 'acme', @repo = 'bad'/);
  assert.match(statements[2]!, /^read: SELECT enabled FROM github.repos.private_vulnerability_reporting WHERE owner = 'acme' AND repo = 'bad'/);
  const inserts = statements.filter((s) => s.includes("INSERT INTO github.issues.issues"));
  assert.equal(inserts.length, 2, "one issue per finding, created since none were open");
  assert.match(inserts[0]!, /^write: INSERT INTO github.issues.issues\(owner, repo, title, body, labels\) SELECT 'acme', 'bad', '\[code-estate-warden\] security_md: SECURITY.md', '.*Security Policy.*', '\["code-estate-warden"\]'/s);
  assert.ok(statements.some((s) => s.startsWith(`write: INSERT INTO github.issues.assignees(issue_number, owner, repo, assignees) SELECT 7, 'acme', 'bad', '["copilot-swe-agent[bot]"]'`)), "pr items are assigned to copilot");
  assert.ok(!statements.some((s) => s.includes("UPDATE github.issues.issues")));
  assert.equal(outcomes[1]?.note, "#7 created, assigned to copilot-swe-agent[bot]");

  const db = new DatabaseSync(join("runs", `${RUN}.db`), { readOnly: true });
  const audit = db.prepare("SELECT key, who, what, before, after FROM audit ORDER BY rowid").all() as Record<string, string>[];
  db.close();
  assert.equal(audit.length, 3);
  assert.deepEqual([audit[0]?.key, audit[0]?.who, audit[0]?.what, audit[0]?.after], ["acme/bad:private_vuln_reporting:setting", "bot", "enable private vulnerability reporting", '{"enabled":"true"}']);
  assert.equal(JSON.parse(audit[0]!.before!).enabled, 0, "before comes from the finding's evidence");
});

test("apply updates an open issue in place and honours the filter and the allowlist", async () => {
  process.env[stackql.WRITE_TOKEN_VAR] = "token";
  const statements = fakeStackql({ security_md: "3" });
  const outcomes = await apply(config, loadPlan(RUN), evaluation, { apply: true, assignCopilot: false, filter: "security_md" }, () => {});
  assert.deepEqual(outcomes.map((o) => [o.key, o.result, o.note]), [["acme/bad:security_md:pr", "applied", "#3 updated"]]);
  assert.ok(statements.some((s) => s.startsWith("write: UPDATE github.issues.issues SET body = ") && s.includes("issue_number = 3")));
  assert.ok(!statements.some((s) => s.includes("INSERT INTO")));

  const outside = { ...loadPlan(RUN), items: [{ ...loadPlan(RUN).items[1]!, org: "other", key: "other/x:security_md:pr" }, { ...loadPlan(RUN).items[1]!, repo: "old", key: "acme/old:security_md:pr" }] };
  const guarded = await apply(Config.parse({ ...config, apply_checks: [] }), outside, evaluation, { apply: true, assignCopilot: false }, () => {});
  assert.deepEqual(guarded.map((o) => [o.result, o.note]), [["skipped", "org not in allowlist"], ["skipped", "archived"]]);
});

test("apply skips settings that are not on the allowlist", async () => {
  process.env[stackql.WRITE_TOKEN_VAR] = "token";
  const statements = fakeStackql({});
  const outcomes = await apply(Config.parse({ ...config, apply_checks: [] }), loadPlan(RUN), evaluation, { apply: true, assignCopilot: false, filter: "private_vuln" }, () => {});
  assert.deepEqual(outcomes.map((o) => [o.result, o.note]), [["skipped", "not in apply_checks"]]);
  assert.ok(!statements.some((s) => /^write: (EXEC|INSERT|UPDATE)/.test(s)), "nothing mutated");
});
