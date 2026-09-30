// Schema and loader for repo-warden.toml.

import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { Severity } from "./types.ts";

export const Config = z.strictObject({
  enterprise: z.string().min(1),
  orgs: z.array(z.string().min(1)).min(1),
  exclude_repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected org/repo")).default([]),
  model: z.string().min(1),
  issue_label: z.string().min(1).default("repo-warden"),
  severity: z.record(z.string(), Severity).default({}),
});

export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  const result = Config.safeParse(parse(readFileSync(path, "utf8")));
  if (!result.success) throw new Error(`${path}\n${z.prettifyError(result.error)}`);
  return result.data;
}
