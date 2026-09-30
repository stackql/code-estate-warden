import assert from "node:assert/strict";
import { Config } from "../src/config.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { checkIds, evaluate, findingsPath, latestRun, previousEvaluation } from "../src/evaluate.ts";
import { drift, failures, jobSummary, markdown, summarise, terminal } from "../src/report.ts";
import { load, readFixture } from "./fixture.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme", "beta"], exclude_repos: ["beta/skip"], model: "m", issue_label: "l", severity: { secret_scanning: "high" as const, license_file: "low" as const } });
const RUN = "01FIXTURE0000000000000000A";
const PREVIOUS = "01FIXTURE00000000000000009";
const cwd = process.cwd();
let work: string;

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
  mkdirSync(join(work, "runs"));
  load(readFixture("snapshot").tables, join(work, "runs", `${RUN}.db`)).close();
  const previous = {
    run_id: PREVIOUS,
    observed_at: "2026-01-01T00:00:00.000Z",
    findings: [
      { org: "acme", repo: "good", check_id: "license_file", status: "fail" },
      { org: "acme", repo: "bad", check_id: "secret_scanning", status: "pass" },
    ],
  };
  writeFileSync(join(work, "runs", `${PREVIOUS}.json`), JSON.stringify(previous));
  process.chdir(work);
});

after(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
});

test("evaluate runs every check, applies exclusions and writes the findings", () => {
  assert.equal(latestRun(), RUN);
  const evaluation = evaluate(config, RUN, null);
  assert.equal(evaluation.run_id, RUN);
  assert.equal(evaluation.observed_at, "2026-01-02T00:00:00.000Z");
  const repoChecks = checkIds().filter((id) => !id.startsWith("org_")).length;
  const orgChecks = checkIds().length - repoChecks;
  // 3 repos after excluding beta/skip, 2 orgs
  assert.equal(evaluation.findings.length, 3 * repoChecks + 2 * orgChecks);
  assert.ok(!evaluation.findings.some((f) => f.repo === "skip"));

  const status = (repo: string, check: string) =>
    evaluation.findings.find((f) => f.repo === repo && f.check_id === check)?.status;
  assert.equal(status("good", "secret_scanning"), "pass");
  assert.equal(status("bad", "secret_scanning"), "fail");
  assert.equal(status("old", "secret_scanning"), "na");
  assert.equal(status("good", "dependabot_alerts"), "unknown");
  assert.equal(status("*", "org_two_factor"), "pass");
  assert.equal(evaluation.findings.find((f) => f.check_id === "license_file")?.severity, "low");
  assert.equal(evaluation.findings.find((f) => f.check_id === "code_scanning")?.severity, "medium");

  const written = JSON.parse(readFileSync(findingsPath(RUN), "utf8"));
  assert.deepEqual(written, evaluation);
});

test("drift compares with the previous run", () => {
  const evaluation = evaluate(config, RUN, null);
  const previous = previousEvaluation(RUN);
  assert.equal(previous?.run_id, PREVIOUS);
  const change = drift(evaluation, previous);
  assert.deepEqual(change.passing.map((f) => `${f.repo}:${f.check_id}`), ["good:license_file"]);
  assert.ok(change.failing.some((f) => f.repo === "bad" && f.check_id === "secret_scanning"));
  // the previous run only held two findings, so every other failure is new
  assert.equal(change.failing.length, failures(evaluation.findings).length);
  assert.deepEqual(drift(evaluation, undefined), { failing: [], passing: [] });
});

test("report renders the summary, sorted by org then severity", () => {
  const evaluation = evaluate(config, RUN, null);
  const rows = summarise(evaluation.findings);
  // acme has every check, beta only the org level ones since its one repo is excluded
  assert.equal(rows.length, checkIds().length + 2);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.org, r.severity, r.check_id]), [["acme", "high", "secret_scanning"], ["acme", "medium", "code_scanning"]]);
  assert.equal(rows.at(-3)?.check_id, "license_file");
  assert.equal(rows.find((r) => r.org === "acme" && r.check_id === "secret_scanning")?.counts.fail, 1);

  const text = terminal(evaluation, drift(evaluation, previousEvaluation(RUN)));
  assert.match(text, /^run 01FIXTURE0000000000000000A/);
  assert.match(text, /newly passing \(1\)\n  acme\/good  license_file/);

  const md = markdown(evaluation, { failing: [], passing: [] });
  assert.match(md, /\| acme \| secret_scanning \| high \| 1 \| 1 \| 1 \| 0 \|/);
  assert.match(md, /<details><summary>All failing/);

  const summary = join(work, "summary.md");
  process.env.GITHUB_STEP_SUMMARY = summary;
  assert.equal(jobSummary(md), true);
  delete process.env.GITHUB_STEP_SUMMARY;
  assert.equal(readFileSync(summary, "utf8"), md);
  assert.equal(jobSummary(md), false);
  assert.ok(existsSync(findingsPath(RUN)));
});
