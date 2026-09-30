#!/usr/bin/env node
// repo-warden command line entrypoint.

import { existsSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "./config.ts";
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

program
  .command("evaluate")
  .description("run every check against the snapshot and report the findings")
  .action(stub("evaluate"));

program
  .command("plan")
  .description("turn findings into a change set, nothing is applied")
  .action(stub("plan"));

program
  .command("apply")
  .description("apply a change set, requires --apply and a write token")
  .action(stub("apply"));

program.command("run").description("snapshot -> evaluate -> plan").action(stub("run"));

try {
  await program.parseAsync();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
