import assert from "node:assert/strict";
import { Config } from "../src/config.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PermissionRequest } from "@github/copilot-sdk";
import { compilePolicy, instruction, permissionHandler, tools, type PlanContext } from "../src/agent.ts";
import { checkIds, evaluate } from "../src/evaluate.ts";
import type { ChangeItem } from "../src/types.ts";
import { FakeRuntime } from "./fake.ts";
import { load, readFixture } from "./fixture.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme", "beta"], exclude_repos: ["beta/skip"], model: "m", issue_label: "l", severity: {} });
const RUN = "01FIXTURE0000000000000000A";
const cwd = process.cwd();
let work: string;
let ctx: PlanContext;

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
  mkdirSync(join(work, "runs"));
  load(readFixture("snapshot").tables, join(work, "runs", `${RUN}.db`)).close();
  process.chdir(work);
  ctx = { config, evaluation: evaluate(config, RUN, null), changes: [] };
});

after(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
});

const call = (name: string, args: unknown = {}) => {
  const tool = tools(ctx).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.handler(tool.parameters.parse(args)) as Record<string, any>;
};

test("instructions are prose files with placeholders", () => {
  assert.match(instruction("system_prompt"), /propose_change/);
  assert.match(instruction("compile_policy", { checks: "- x", policy: "P" }), /- x[\s\S]*P/);
  assert.throws(() => instruction("compile_policy", {}), /no value for \{\{checks\}\}/);
});

test("permission handler approves our tools and read only MCP calls, refuses the rest", () => {
  const decide = (request: Partial<PermissionRequest>) => (permissionHandler(request as PermissionRequest, { sessionId: "s" }) as { kind: string }).kind;
  assert.equal(decide({ kind: "custom-tool", toolName: "propose_change" }), "approve-once");
  assert.equal(decide({ kind: "mcp", readOnly: true, serverName: "stackql" }), "approve-once");
  assert.equal(decide({ kind: "mcp", readOnly: false, serverName: "stackql" }), "reject");
  assert.equal(decide({ kind: "shell" }), "reject");
  assert.equal(decide({ kind: "write" }), "reject");
});

test("read tools describe the snapshot and the findings", () => {
  assert.equal(call("list_checks").length, checkIds().length);
  const summary = call("get_snapshot_summary");
  assert.equal(summary.run.run_id, RUN);
  assert.deepEqual(summary.orgs.map((o: { org: string; repos: number }) => [o.org, o.repos]), [["acme", 3], ["beta", 1]]);
  assert.deepEqual(call("run_check", { check_id: "secret_scanning" }), { counts: { pass: 1, fail: 1, na: 1 }, failing: ["acme/bad"], failing_total: 1 });
  assert.deepEqual(call("run_check", { check_id: "nope" }), { error: "unknown check nope" });
  const findings = call("get_findings", { org: "acme", status: "fail" });
  assert.ok(findings.total > 0 && findings.findings.every((f: { org: string; status: string }) => f.org === "acme" && f.status === "fail"));
  assert.ok(!("run_id" in findings.findings[0]), "compact rows");
});

test("propose_change refuses what the rules forbid and records the rest idempotently", () => {
  const base = { action: "setting", check_id: "secret_scanning", target: "secret_scanning", after: "enabled", reason: "policy" };
  assert.deepEqual(call("propose_change", { ...base, org: "other", repos: ["x"] }), { refused: "other is not in the org allowlist" });
  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["bad"], check_id: "nope" }), { refused: "unknown check nope" });
  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["bad"], after: "disabled" }), { refused: "a control is never disabled" });
  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["old"] }), { refused: "acme/old is archived" });
  assert.deepEqual(call("propose_change", { ...base, org: "beta", repos: ["skip"] }), { refused: "beta/skip is excluded by config" });
  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["good"] }), { refused: "acme/good does not fail secret_scanning" });
  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["missing"] }), { refused: "acme/missing does not fail secret_scanning" });
  assert.equal(ctx.changes.length, 0);

  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["bad"] }), { added: ["acme/bad:secret_scanning:setting"] });
  const item = ctx.changes[0] as ChangeItem;
  assert.deepEqual(item.before, { status: "disabled", archived: 0 });
  assert.equal(item.after, "enabled");
  call("propose_change", { ...base, org: "acme", repos: ["bad"], reason: "again" });
  assert.equal(ctx.changes.length, 1, "same key replaces");
  assert.equal(ctx.changes[0]?.reason, "again");

  assert.deepEqual(call("propose_change", { ...base, org: "acme", repos: ["*"], target: "security configuration" }), { added: ["acme/*:secret_scanning:setting"] });
  assert.deepEqual(call("propose_change", { ...base, org: "beta", repos: ["*"] }), { refused: "beta/* does not fail secret_scanning" });
  assert.equal(ctx.changes.length, 2);
});

test("compilePolicy validates the reply and saves the manifest", async () => {
  const saved: unknown[] = [];
  const save = (m: unknown) => void saved.push(m);
  const runtime = new FakeRuntime({ checks: [{ id: "secret_scanning", scope: "all" }, { id: "license_file", scope: "public", exempt_forks: true }] });
  const manifest = await compilePolicy(runtime, "the policy text", save);
  assert.equal(manifest.checks.length, 2);
  assert.deepEqual(manifest.checks[1], { id: "license_file", scope: "public", exempt_forks: true, exempt: [] });
  assert.match(runtime.prompts[0]!, /- secret_scanning: security_and_analysis[\s\S]*the policy text/);
  assert.deepEqual(saved, [manifest]);

  const bad = new FakeRuntime({ checks: [{ id: "made_up" }] });
  await assert.rejects(compilePolicy(bad, "p", save), /unknown checks: made_up/);
  const empty = new FakeRuntime({ checks: [] });
  await assert.rejects(compilePolicy(empty, "p", save));
  assert.equal(saved.length, 1, "nothing saved on failure");
});

test("the manifest exempts findings with the reason in the evidence", () => {
  const manifest = { checks: [{ id: "license_file", scope: "public" as const, exempt_forks: false, exempt: ["acme/bad"] }, { id: "org_two_factor", scope: "all" as const, exempt_forks: false, exempt: [] }] };
  const { findings } = evaluate(config, RUN, manifest);
  assert.deepEqual([...new Set(findings.map((f) => f.check_id))].sort(), ["license_file", "org_two_factor"], "only checks in the manifest run");
  const bad = findings.find((f) => f.repo === "bad" && f.check_id === "license_file");
  assert.equal(bad?.status, "na");
  assert.equal(bad?.evidence.exempt, "listed in policy");
  assert.equal(bad?.remediation, "none");
  assert.equal(findings.find((f) => f.repo === "good")?.status, "pass", "public repo still evaluated");
});
