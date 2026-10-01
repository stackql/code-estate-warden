// Schema and loader for code-estate-warden.toml.

import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { RepoName, Severity } from "./types.ts";

export const Config = z.strictObject({
  enterprise: z.string().min(1),
  orgs: z.array(z.string().min(1)).min(1),
  exclude_repos: z.array(RepoName).default([]),
  model: z.string().min(1),
  issue_label: z.string().min(1).default("code-estate-warden"),
  /** checks whose setting changes apply may make; everything else is plan only */
  apply_checks: z.array(z.string()).default(["private_vuln_reporting"]),
  /** SPDX id of the license proposed for repos without one */
  license: z.string().min(1).default("MIT"),
  severity: z.record(z.string(), Severity).default({}),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  const result = Config.safeParse(parse(readFileSync(path, "utf8")));
  if (!result.success) throw new Error(`${path}\n${z.prettifyError(result.error)}`);
  return result.data;
}
