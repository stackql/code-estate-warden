#!/usr/bin/env node
// repo-warden command line entrypoint.

import { existsSync } from "node:fs";
import { Command } from "commander";
import { CopilotRuntime, compilePolicy } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { evaluate, previousEvaluation } from "./evaluate.ts";
import { apply, loadPlan, plan, planPath, renderPlan } from "./remediate.ts";
import { drift, jobSummary, markdown, terminal } from "./report.ts";
import { snapshot } from "./snapshot.ts";
import * as stackql from "./stackql.ts";

if (existsSync(".env")) process.loadEnvFile();

const program = new Command("repo-warden")
  .description("Security posture audit and remediation for GitHub organizations")
  .option("-c, --config <path>", "path to the config file", "repo-warden.toml");

program
  .command("bootstrap")
  .description("check the stackql binary (download it if missing) and pull the github provider")
  .action(async () => {
    if (!(await stackql.version())) await stackql.install();
    console.log(`stackql binary: ${stackql.binary()}`);
    console.log(`${stackql.PROVIDER} provider: ${await stackql.pullProvider()}`);
  });

program
  .command("snapshot")
  .description("build the inventory snapshot with StackQL")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const started = Date.now();
    const result = await snapshot(config);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`run ${result.run_id}: ${result.repos} repos across ${config.orgs.length} orgs in ${seconds}s -> ${result.db}`);
  });

const report = (runId?: string, asMarkdown = false) => {
  const evaluation = evaluate(loadConfig(program.opts().config), runId);
  const change = drift(evaluation, previousEvaluation(evaluation.run_id));
  const md = markdown(evaluation, change);
  console.log(asMarkdown ? md : terminal(evaluation, change));
  if (jobSummary(md)) console.log("\njob summary written");
};

program
  .command("evaluate")
  .description("run every check against a snapshot, write the findings, print the report")
  .option("-r, --run <run_id>", "snapshot to evaluate, default the latest")
  .option("-m, --markdown", "print markdown instead of the terminal table")
  .action((opts: { run?: string; markdown?: boolean }) => report(opts.run, opts.markdown));

const makePlan = async (runId?: string, compile = false) => {
  const config = loadConfig(program.opts().config);
  const runtime = new CopilotRuntime(config);
  if (compile) {
    const manifest = await compilePolicy(runtime);
    console.log(`policy compiled: ${manifest.checks.length} checks in scope\n`);
  }
  const evaluation = evaluate(config, runId);
  console.log(`planning ${evaluation.run_id} with ${config.model}`);
  const result = await plan(config, runtime, evaluation);
  console.log(`\n${renderPlan(result)}\n\nwritten to ${planPath(result.run_id)}`);
};

program
  .command("plan")
  .description("turn findings into a change set with the agent, nothing is applied")
  .option("-r, --run <run_id>", "snapshot to plan from, default the latest")
  .option("--compile-policy", "recompile policy/manifest.json from policy/core-controls.md first (one prompt)")
  .action((opts: { run?: string; compilePolicy?: boolean }) => makePlan(opts.run, opts.compilePolicy));

program
  .command("apply")
  .description("apply a plan: dry run unless --apply, which needs REPO_WARDEN_WRITE_TOKEN")
  .option("-r, --run <run_id>", "run whose plan to apply, default the latest")
  .option("--apply", "make the changes, otherwise only show what would be done")
  .option("--assign-copilot", "assign issues for file changes to the Copilot coding agent")
  .option("-f, --filter <text>", "only changes whose key contains this text, e.g. an org/repo")
  .action(async (opts: { run?: string; apply?: boolean; assignCopilot?: boolean; filter?: string }) => {
    const config = loadConfig(program.opts().config);
    const evaluation = evaluate(config, opts.run);
    const outcomes = await apply(config, loadPlan(evaluation.run_id), evaluation, { apply: !!opts.apply, assignCopilot: !!opts.assignCopilot, filter: opts.filter });
    const count = (result: string) => outcomes.filter((o) => o.result === result).length;
    console.log(`\n${count("applied")} applied, ${count("planned")} planned, ${count("skipped")} skipped${opts.apply ? "" : " (dry run, add --apply to make changes)"}`);
  });

program
  .command("run")
  .description("snapshot -> evaluate -> plan")
  .action(async () => {
    const result = await snapshot(loadConfig(program.opts().config));
    console.log("");
    report(result.run_id);
    console.log("");
    await makePlan(result.run_id);
  });

try {
  await program.parseAsync();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
