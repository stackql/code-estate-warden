// Layer 5, remediate (agentic, gated): change set, plan (agent), apply (gated), issues, audit.
//
// plan asks the agent for a change set, one prompt per org that has failures; the agent proposes
// through the tools and the result is runs/<run_id>.plan.json. apply is a dry run unless --apply:
// settings for checks on the apply_checks allowlist are mutated with StackQL and confirmed with a
// read, issues are created or updated in place, and every applied change gets an audit row in the
// run file. Nothing here touches a repo outside the org allowlist or an archived one.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type AgentRuntime, fill, instruction, tools } from "./agent.ts";
import type { Config } from "./config.ts";
import { checks, type Evaluation } from "./evaluate.ts";
import { RUNS, dbPath } from "./snapshot.ts";
import * as stackql from "./stackql.ts";
import { ChangeItem, type Finding } from "./types.ts";

const TEMPLATES = fileURLToPath(new URL("../templates", import.meta.url));
const POLICY = fileURLToPath(new URL("../policy/core-controls.md", import.meta.url));
const COPILOT = "copilot-swe-agent[bot]";

export const Plan = z.strictObject({
  run_id: z.string(),
  created_at: z.iso.datetime(),
  model: z.string(),
  items: z.array(ChangeItem),
  summaries: z.record(z.string(), z.string()),
});

export type Plan = z.infer<typeof Plan>;

const Reply = z.object({
  summary: z.string(),
  left_out: z.array(z.string()).default([]),
});

export const planPath = (runId: string) => posix.join(RUNS, `${runId}.plan.json`);

export function loadPlan(runId: string): Plan {
  if (!existsSync(planPath(runId))) throw new Error(`no plan ${planPath(runId)}, run \`repo-warden plan\` first`);
  return Plan.parse(JSON.parse(readFileSync(planPath(runId), "utf8")));
}

const template = (name: string, vars: Record<string, string>) => {
  const path = `${TEMPLATES}/${name}.md`;
  return fill(readFileSync(existsSync(path) ? path : `${TEMPLATES}/generic.md`, "utf8"), vars);
};

/** One prompt per org with failures. The agent proposes through the tools; its reply is a summary. */
export async function plan(config: Config, runtime: AgentRuntime, evaluation: Evaluation, log = console.log): Promise<Plan> {
  const items: ChangeItem[] = [];
  const summaries: Record<string, string> = {};
  const policy = readFileSync(POLICY, "utf8");
  const toolset = tools({ config, evaluation, changes: items });
  for (const org of config.orgs) {
    const failing = evaluation.findings.filter((f) => f.org === org && f.status === "fail");
    if (!failing.length) {
      log(`  ${org.padEnd(18)} nothing fails, no prompt`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const f of failing) counts.set(f.check_id, (counts.get(f.check_id) ?? 0) + 1);
    const summary = [...counts]
      .map(([id, n]) => {
        const f = failing.find((x) => x.check_id === id)!;
        return `- ${id} (${f.severity}, remediation ${f.remediation}): ${n}`;
      })
      .join("\n");
    const configurations = evaluation.findings.find((f) => f.org === org && f.check_id === "org_security_configuration")?.evidence.configurations;
    const reply = await runtime.ask({
      prompt: instruction("plan", { org, run_id: evaluation.run_id, summary, configurations: JSON.stringify(configurations ?? "none"), policy }),
      tools: toolset,
      schema: Reply,
    });
    summaries[org] = reply.left_out.length ? `${reply.summary}\nLeft out: ${reply.left_out.join("; ")}` : reply.summary;
    log(`  ${org.padEnd(18)} ${items.filter((c) => c.org === org).length} changes proposed`);
  }
  const result: Plan = { run_id: evaluation.run_id, created_at: new Date().toISOString(), model: config.model, items, summaries };
  writeFileSync(planPath(evaluation.run_id), JSON.stringify(result, null, 1));
  return result;
}

/** The plan as text: one line per group of repos that get the same change. */
export function renderPlan(plan: Plan): string {
  const groups = new Map<string, ChangeItem[]>();
  for (const item of plan.items) {
    const key = [item.org, item.action, item.check_id, item.target, item.after].join("\t");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const lines = [...groups.values()].map((group) => {
    const { org, action, check_id, target, after } = group[0]!;
    const repos = group.map((i) => i.repo);
    const list = repos.length > 5 ? `${repos.slice(0, 5).join(", ")} and ${repos.length - 5} more` : repos.join(", ");
    return `  ${action.padEnd(8)} ${org.padEnd(18)} ${check_id.padEnd(28)} ${target}: ${after}  [${repos.length}] ${list}`;
  });
  const summaries = Object.entries(plan.summaries).map(([org, text]) => `${org}: ${text}`);
  return [`plan ${plan.run_id}, ${plan.items.length} changes`, ...lines, "", ...summaries].join("\n");
}

const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Setting changes apply knows how to make. Each mutation has the read that confirms it. */
const MUTATIONS: Record<string, { what: string; mutate: (org: string, repo: string) => string; read: (org: string, repo: string) => string }> = {
  private_vuln_reporting: {
    what: "enable private vulnerability reporting",
    mutate: (org, repo) =>
      `EXEC github.repos.private_vulnerability_reporting.enable_private_vulnerability_reporting @owner = ${lit(org)}, @repo = ${lit(repo)}`,
    read: (org, repo) => `SELECT enabled FROM github.repos.private_vulnerability_reporting WHERE owner = ${lit(org)} AND repo = ${lit(repo)}`,
  },
};

export interface ApplyOptions {
  apply: boolean;
  assignCopilot: boolean;
  /** only items whose key contains this text */
  filter?: string;
}

export interface Outcome {
  key: string;
  what: string;
  result: "applied" | "planned" | "skipped";
  note?: string;
}

/** An org level setting proposal for a check apply can mutate becomes one item per failing repo. */
function expand(items: ChangeItem[], findings: Finding[]): ChangeItem[] {
  return items.flatMap((item) => {
    if (item.repo !== "*" || item.action !== "setting" || !MUTATIONS[item.check_id]) return [item];
    return findings
      .filter((f) => f.org === item.org && f.check_id === item.check_id && f.status === "fail")
      .map((f) => ({ ...item, repo: f.repo, key: `${f.org}/${f.repo}:${f.check_id}:setting`, before: f.evidence, reason: `${item.reason} (org level proposal applied per repo)` }));
  });
}

function issueBody(item: ChangeItem, finding: Finding | undefined, config: Config, runId: string): { title: string; body: string } {
  const check = checks().find((c) => c.id === item.check_id);
  const details = template(item.check_id, {
    org: item.org,
    repo: item.repo,
    license: config.license,
    security_policy: template("SECURITY", { org: item.org, repo: item.repo }),
    target: item.target,
    after: item.after,
  });
  const body = template("issue", {
    org: item.org,
    repo: item.repo,
    check_id: item.check_id,
    severity: finding?.severity ?? "",
    finding: check?.description ?? item.check_id,
    observed_at: finding?.observed_at ?? "",
    evidence: JSON.stringify(item.before, null, 2),
    change: `${item.target}: ${item.after}. ${item.reason}`,
    details,
    run_id: runId,
  });
  return { title: `[${config.issue_label}] ${item.check_id}: ${item.target}`, body };
}

/** Create the issue, or update the open one with the same label and check in its title. */
async function upsertIssue(org: string, repo: string, title: string, body: string, checkId: string, label: string): Promise<{ number: string; created: boolean }> {
  const search = `SELECT number, title FROM github.issues.issues WHERE owner = ${lit(org)} AND repo = ${lit(repo)} AND state = 'open' AND labels = ${lit(label)}`;
  const existing = (await stackql.query(search)).find((i) => i.title?.includes(checkId));
  if (existing) {
    await stackql.run(`UPDATE github.issues.issues SET body = ${lit(body)} WHERE owner = ${lit(org)} AND repo = ${lit(repo)} AND issue_number = ${existing.number}`, stackql.WRITE_TOKEN_VAR);
    return { number: existing.number!, created: false };
  }
  const output = await stackql.run(
    `INSERT INTO github.issues.issues(owner, repo, title, body, labels) SELECT ${lit(org)}, ${lit(repo)}, ${lit(title)}, ${lit(body)}, ${lit(JSON.stringify([label]))}`,
    stackql.WRITE_TOKEN_VAR,
  );
  const created = (await stackql.query(search)).find((i) => i.title?.includes(checkId));
  if (!created) throw new Error(`issue for ${checkId} not found in ${org}/${repo} after creating it\n${output.stderr}`);
  return { number: created.number!, created: true };
}

export async function apply(config: Config, plan: Plan, evaluation: Evaluation, options: ApplyOptions, log = console.log): Promise<Outcome[]> {
  if (options.apply && !process.env[stackql.WRITE_TOKEN_VAR]) throw new Error(`${stackql.WRITE_TOKEN_VAR} is not set`);
  const db = new DatabaseSync(dbPath(plan.run_id));
  const archived = new Set(
    (db.prepare("SELECT org, name FROM repos WHERE archived = 1").all() as { org: string; name: string }[]).map((r) => `${r.org}/${r.name}`.toLowerCase()),
  );
  const orgs = new Set(config.orgs.map((o) => o.toLowerCase()));
  db.exec("CREATE TABLE IF NOT EXISTS audit (run_id TEXT, key TEXT, who TEXT, what TEXT, before TEXT, after TEXT, applied_at TEXT)");
  const audit = db.prepare("INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?)");
  const who = options.apply ? String((await stackql.query("SELECT login FROM github.users.users", stackql.WRITE_TOKEN_VAR))[0]?.login) : "";
  const record = (item: ChangeItem, what: string, after: unknown) =>
    audit.run(plan.run_id, item.key, who, what, JSON.stringify(item.before), JSON.stringify(after), new Date().toISOString());

  const outcomes: Outcome[] = [];
  const items = expand(plan.items, evaluation.findings).filter((i) => !options.filter || i.key.includes(options.filter));
  try {
    for (const item of items) await applyItem(item);
  } finally {
    db.close();
  }
  return outcomes;

  async function applyItem(item: ChangeItem): Promise<void> {
    const name = `${item.org}/${item.repo}`;
    const finding = evaluation.findings.find((f) => f.org === item.org && f.repo === item.repo && f.check_id === item.check_id);
    const done = (result: Outcome["result"], what: string, note?: string) => {
      outcomes.push({ key: item.key, what, result, note });
      log(`  ${result.padEnd(8)} ${item.key.padEnd(60)} ${what}${note ? ` (${note})` : ""}`);
    };
    if (!orgs.has(item.org.toLowerCase())) { done("skipped", item.target, "org not in allowlist"); return; }
    if (archived.has(name.toLowerCase())) { done("skipped", item.target, "archived"); return; }

    if (item.action === "setting") {
      const mutation = MUTATIONS[item.check_id];
      if (!config.apply_checks.includes(item.check_id)) { done("skipped", item.target, "not in apply_checks"); return; }
      if (!mutation || item.repo === "*") { done("skipped", item.target, "no mutation for this change in v1"); return; }
      if (!options.apply) { done("planned", mutation.what); return; }
      await stackql.run(mutation.mutate(item.org, item.repo), stackql.WRITE_TOKEN_VAR);
      const [after] = await stackql.query(mutation.read(item.org, item.repo));
      record(item, mutation.what, after);
      done("applied", mutation.what, JSON.stringify(after));
    } else if (item.action === "issue" || item.action === "pr") {
      const { title, body } = issueBody(item, finding, config, plan.run_id);
      const what = `${item.action === "pr" ? "issue for the coding agent" : "issue"}: ${title}`;
      if (!options.apply) { done("planned", what); return; }
      const issue = await upsertIssue(item.org, item.repo, title, body, item.check_id, config.issue_label);
      let note = `#${issue.number} ${issue.created ? "created" : "updated"}`;
      if (options.assignCopilot && item.action === "pr") {
        await stackql.run(
          `INSERT INTO github.issues.assignees(issue_number, owner, repo, assignees) SELECT ${issue.number}, ${lit(item.org)}, ${lit(item.repo)}, ${lit(JSON.stringify([COPILOT]))}`,
          stackql.WRITE_TOKEN_VAR,
        );
        note += `, assigned to ${COPILOT}`;
      }
      record(item, what, { issue: issue.number });
      done("applied", what, note);
    } else {
      done("skipped", item.target, "manual");
    }
  }
}
