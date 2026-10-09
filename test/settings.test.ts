import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { http } from "../src/dependabot.ts";
import { enable, SETTINGS } from "../src/settings.ts";
import * as stackql from "../src/stackql.ts";

const token = process.env[stackql.READ_TOKEN_VAR];
afterEach(() => {
  mock.restoreAll();
  if (token === undefined) delete process.env[stackql.READ_TOKEN_VAR];
  else process.env[stackql.READ_TOKEN_VAR] = token;
});

test("every core setting is enabled through StackQL and confirmed with the read token", async () => {
  const statements: string[] = [];
  process.env[stackql.READ_TOKEN_VAR] = "read";
  mock.method(http, "fetch", async () => new Response(null, { status: 204 }));
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1)!;
    const write = args[args.indexOf("--auth") + 1]!.includes("WRITE_TOKEN");
    statements.push(sql);
    if (/^(UPDATE|EXEC)/.test(sql)) {
      assert.ok(write);
      return { stdout: "", stderr: "The operation was despatched successfully" };
    }
    assert.ok(!write, "verification reads never use the write token");
    const row = sql.includes("github.repos.details")
      ? { full_name: "acme/one", archived: "false", permissions: '{"admin":true}', security_and_analysis: '{"secret_scanning":{"status":"enabled"}}' }
      : sql.includes("default_setup") ? { state: "configured" } : { enabled: "true", paused: "false" };
    return { stdout: JSON.stringify([row]), stderr: "" };
  });
  for (const id of ["secret_scanning", "code_scanning", "dependabot_alerts", "dependabot_security_updates", "private_vuln_reporting"]) {
    assert.ok(SETTINGS[id]!.confirmed(await enable(id, "acme", "one")), id);
  }
  assert.ok(statements.some((sql) => sql.includes('{"secret_scanning":{"status":"enabled"}}')));
  assert.ok(!statements.some((sql) => sql.includes('"advanced_security"')), "no unrequested licensed control is enabled");
});

test("unconfirmed settings and mutation HTTP errors cannot become successes", async () => {
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => ({
    stdout: args.at(-1)!.startsWith("EXEC") ? "" : '[{"enabled":"false"}]', stderr: "",
  }));
  await assert.rejects(enable("private_vuln_reporting", "acme", "one"), /not confirmed/);
  mock.method(stackql.io, "spawn", async () => ({ stdout: "", stderr: "http response status code: 403" }));
  await assert.rejects(enable("secret_scanning", "acme", "one"), /403/);
});

test("new main protection requires one approval, admin bypass and no required CI checks", async () => {
  let protectedMain = false;
  let mutation = "";
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1)!;
    if (sql.startsWith("REPLACE")) {
      mutation = sql;
      protectedMain = true;
      return { stdout: "", stderr: "success" };
    }
    return { stdout: JSON.stringify([sql.includes("github.repos.branch_protection")
      ? { required_pull_request_reviews: '{"required_approving_review_count":1}', enforce_admins: '{"enabled":false}' }
      : { name: "main", protected: String(protectedMain) }]), stderr: "" };
  });
  await enable("main_branch_protected", "acme", "one");
  assert.match(mutation, /SELECT 'acme', 'one', 'main', false, '{"required_approving_review_count":1}', null, null/);
  assert.doesNotMatch(mutation, /'master'|default_branch/);
});

test("main upgrades preserve reviews, CI checks, restrictions and administrator enforcement", async () => {
  const current = {
    required_pull_request_reviews: JSON.stringify({
      required_approving_review_count: 2, dismiss_stale_reviews: true, require_code_owner_reviews: true,
      dismissal_restrictions: { users: [{ login: "owner" }], teams: [{ slug: "security" }], apps: [] },
      bypass_pull_request_allowances: { users: [{ login: "owner" }], teams: [], apps: [] },
    }),
    required_status_checks: '{"strict":true,"contexts":["build"],"checks":[{"context":"build","app_id":42}]}',
    restrictions: '{"users":[{"login":"owner"}],"teams":[{"slug":"security"}],"apps":[{"slug":"bot"}]}',
    enforce_admins: '{"enabled":true}', required_linear_history: '{"enabled":true}', allow_deletions: '{"enabled":false}',
  };
  let mutation = "";
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1)!;
    if (sql.startsWith("REPLACE")) { mutation = sql; return { stdout: "", stderr: "success" }; }
    return { stdout: JSON.stringify([sql.includes("github.repos.branch_protection") ? current : { name: "main", protected: "true" }]), stderr: "" };
  });
  await enable("main_branch_protected", "acme", "one");
  assert.match(mutation, /'main', true,/);
  assert.match(mutation, /"required_approving_review_count":2/);
  assert.match(mutation, /"require_code_owner_reviews":true/);
  assert.match(mutation, /"contexts":\["build"\]/);
  assert.match(mutation, /"users":\["owner"\],"teams":\["security"\],"apps":\["bot"\]/);
  assert.match(mutation, /required_linear_history, allow_deletions/);
});

test("main is never created, and unreadable existing protection is never replaced", async () => {
  const writes: string[] = [];
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1)!;
    if (sql.startsWith("REPLACE")) writes.push(sql);
    return { stdout: "null", stderr: "" };
  });
  await assert.rejects(enable("main_branch_protected", "acme", "one"), /main is absent/);
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => ({
    stdout: args.at(-1)!.includes("github.repos.branch_protection") ? "null" : '[{"name":"main","protected":"true"}]', stderr: "",
  }));
  await assert.rejects(enable("main_branch_protected", "acme", "one"), /refusing to replace/);
  assert.equal(writes.length, 0);
});

test("existing main protection with null review and CI fields can gain the missing PR requirement", async () => {
  let written = false;
  let mutation = "";
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) => {
    const sql = args.at(-1)!;
    if (sql.startsWith("REPLACE")) {
      written = true;
      mutation = sql;
      return { stdout: "", stderr: "success" };
    }
    const row = sql.includes("github.repos.branch_protection") ? {
      required_pull_request_reviews: written ? '{"required_approving_review_count":1}' : "null",
      required_status_checks: "null", restrictions: "null", enforce_admins: '{"enabled":false}',
      allow_fork_syncing: "null",
    } : { name: "main", protected: "true" };
    return { stdout: JSON.stringify([row]), stderr: "" };
  });
  await enable("main_branch_protected", "acme", "one");
  assert.match(mutation, /'main', false, '{"required_approving_review_count":1}', null, null/);
  assert.doesNotMatch(mutation, /allow_fork_syncing/);
});
