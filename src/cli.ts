#!/usr/bin/env node
// repo-warden command line entrypoint.

import { existsSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "./config.ts";
import { evaluate, previousEvaluation } from "./evaluate.ts";
import { drift, jobSummary, markdown, terminal } from "./report.ts";
import { snapshot } from "./snapshot.ts";
import * as stackql from "./stackql.ts";

if (existsSync(".env")) process.loadEnvFile();

const program = new Command("repo-warden")
  .description("Security posture audit and remediation for GitHub organizations")
  .option("-c, --config <path>", "path to the config file", "repo-warden.toml");

const stub = (name: string) => () => {
  loadConfig(program.opts().config);
  throw new Error(`${name}: not implemented yet`);
};

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

program
  .command("plan")
  .description("turn findings into a change set, nothing is applied")
  .action(stub("plan"));

program
  .command("apply")
  .description("apply a change set, requires --apply and a write token")
  .action(stub("apply"));

program
  .command("run")
  .description("snapshot -> evaluate -> plan")
  .action(async () => {
    const result = await snapshot(loadConfig(program.opts().config));
    console.log("");
    report(result.run_id);
  });

try {
  await program.parseAsync();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
