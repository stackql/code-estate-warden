import { z } from "zod";
import type { Config } from "./config.ts";
import type { Finding } from "./types.ts";

export const CORE_CHECKS = [
  "secret_scanning", "code_scanning", "main_branch_protected",
  "private_vuln_reporting", "dependabot_alerts", "dependabot_security_updates", "security_md",
] as const;

export const Selection = z.object({
  org: z.string().min(1).optional().describe("one organization in the configured allowlist"),
  repo: z.string().min(1).optional().describe("one repository as org/repo or https://github.com/org/repo"),
  core: z.boolean().optional().describe("the core five controls plus SECURITY.md"),
});
export type Selection = z.infer<typeof Selection>;

export function select(config: Config, input: Selection = {}): Selection {
  Selection.parse(input);
  let name = input.repo;
  if (name?.startsWith("https://")) {
    const url = new URL(name);
    if (url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("expected a GitHub repository URL: https://github.com/org/repo");
    }
    name = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  if (name && (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(name) || [".", ".."].includes(name.split("/")[1]!))) {
    throw new Error("expected org/repo or https://github.com/org/repo");
  }
  const owner = name?.split("/")[0];
  if (owner && input.org && owner.toLowerCase() !== input.org.toLowerCase()) {
    throw new Error("--org and --repo must target the same organization");
  }
  const requested = owner ?? input.org;
  const org = requested ? config.orgs.find((o) => o.toLowerCase() === requested.toLowerCase()) : undefined;
  if (requested && !org) throw new Error(`${requested} is not in the org allowlist`);
  const repo = name ? `${org}/${name.split("/")[1]}` : undefined;
  if (repo && config.exclude_repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
    throw new Error(`${repo} is excluded by config`);
  }
  return { ...(org ? { org } : {}), ...(repo ? { repo } : {}), ...(input.core ? { core: true } : {}) };
}

export function selected(f: Pick<Finding, "org" | "repo" | "check_id">, scope: Selection): boolean {
  return (!scope.org || f.org.toLowerCase() === scope.org.toLowerCase()) &&
    (!scope.repo || `${f.org}/${f.repo}`.toLowerCase() === scope.repo.toLowerCase()) &&
    (!scope.core || CORE_CHECKS.some((id) => id === f.check_id));
}
