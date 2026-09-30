import assert from "node:assert/strict";
import { Config } from "../src/config.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkIds, runCheck } from "../src/evaluate.ts";
import { FIXTURES, load, readFixture } from "./fixture.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme"], exclude_repos: [], model: "m", issue_label: "l", severity: { secret_scanning: "high" as const } });
const run = { run_id: "01TEST", observed_at: "2026-01-01T00:00:00.000Z" };

test("every check has a fixture", () => {
  for (const id of checkIds()) assert.ok(existsSync(join(FIXTURES, `${id}.json`)), id);
});

for (const id of checkIds()) {
  test(id, () => {
    const fixture = readFixture(id);
    const db = load(fixture.tables);
    const findings = runCheck(db, id, run, config);
    db.close();
    const status = Object.fromEntries(findings.map((f) => [`${f.org}/${f.repo}`, f.status]));
    assert.deepEqual(status, fixture.expect);
    for (const [key, expected] of Object.entries(fixture.evidence ?? {})) {
      const finding = findings.find((f) => `${f.org}/${f.repo}` === key);
      for (const [k, v] of Object.entries(expected)) assert.deepEqual(finding?.evidence[k], v, `${key} ${k}`);
    }
    for (const f of findings) {
      assert.equal(f.check_id, id);
      assert.equal(f.run_id, run.run_id);
      assert.equal(f.severity, id === "secret_scanning" ? "high" : "medium");
      assert.equal(f.remediation === "none", f.status !== "fail", `${f.repo} remediation`);
    }
  });
}
