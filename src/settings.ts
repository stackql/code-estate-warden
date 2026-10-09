import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fill } from "./agent.ts";
import { alerts } from "./dependabot.ts";
import * as stackql from "./stackql.ts";

const SQL = fileURLToPath(new URL("../sql/", import.meta.url));
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const statement = (folder: string, name: string, org: string, repo: string, vars: Record<string, string> = {}) =>
  fill(readFileSync(join(SQL, folder, `${name}.sql`), "utf8"), { org: lit(org), repo: lit(repo), ...vars });
const bool = (value: unknown) => value === true || value === "true";
const decoded = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const object = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(decoded(value) ?? {});

export const repository = async (org: string, repo: string) => {
  const [row] = await stackql.query(statement("reads", "repository", org, repo));
  if (!row) throw new Error(`${org}/${repo} is no longer accessible`);
  if (row.full_name?.toLowerCase() !== `${org}/${repo}`.toLowerCase()) {
    throw new Error(`${org}/${repo}: repository identity changed or could not be confirmed; take a fresh snapshot`);
  }
  if (row.archived !== "true" && row.archived !== "false") throw new Error(`${org}/${repo}: archived state could not be read`);
  return row;
};

export interface Setting {
  what: string;
  read: (org: string, repo: string) => Promise<Record<string, unknown>>;
  confirmed: (row: Record<string, unknown>) => boolean;
  mutate?: (org: string, repo: string) => Promise<{ sql: string; verify: (after: Record<string, unknown>) => boolean }>;
}

const read = (name: string) => async (org: string, repo: string) =>
  (await stackql.query(statement("reads", name, org, repo)))[0] ?? {};

export const SETTINGS: Record<string, Setting> = {
  secret_scanning: {
    what: "enable secret scanning",
    read: repository,
    confirmed: (row) => object(object(row.security_and_analysis).secret_scanning).status === "enabled",
  },
  code_scanning: {
    what: "enable CodeQL default setup",
    read: read("code_scanning"),
    confirmed: (row) => row.state === "configured",
  },
  dependabot_alerts: {
    what: "enable Dependabot vulnerability alerts",
    read: async (org, repo) => {
      const row = await repository(org, repo);
      return alerts(org, repo, bool(object(row.permissions).admin));
    },
    confirmed: (row) => row.enabled === true,
  },
  dependabot_security_updates: {
    what: "enable Dependabot security-update PRs",
    read: read("dependabot_security_updates"),
    confirmed: (row) => bool(row.enabled) && (row.paused === false || row.paused === "false"),
  },
  private_vuln_reporting: {
    what: "enable private vulnerability reporting",
    read: read("private_vuln_reporting"),
    confirmed: (row) => bool(row.enabled),
  },
  main_branch_protected: {
    what: "protect main: pull requests, at least one approval, administrator bypass for new protection",
    read: async (org, repo) => {
      const [branch] = await stackql.query(statement("reads", "main_branch", org, repo));
      if (branch?.name !== "main") throw new Error(`${org}/${repo}: main is absent or inaccessible`);
      return bool(branch.protected) ? read("main_branch_protected")(org, repo) : {};
    },
    confirmed: (row) => Number(object(row.required_pull_request_reviews).required_approving_review_count) >= 1,
    mutate: async (org, repo) => {
      const [branch] = await stackql.query(statement("reads", "main_branch", org, repo));
      if (branch?.name !== "main") throw new Error(`${org}/${repo}: main is absent or inaccessible; no other branch will be changed`);
      const current = bool(branch.protected) ? await read("main_branch_protected")(org, repo) : {};
      if (bool(branch.protected) && !Object.keys(current).length) {
        throw new Error(`${org}/${repo}: cannot read existing main protection; refusing to replace it`);
      }
      const reviews = object(current.required_pull_request_reviews);
      const existingAdmins = object(current.enforce_admins).enabled;
      if (Object.keys(current).length && typeof existingAdmins !== "boolean") {
        throw new Error(`${org}/${repo}: cannot read main administrator enforcement; refusing to replace protection`);
      }
      const enforceAdmins = existingAdmins === true;
      const checks = decoded(current.required_status_checks) == null ? null : object(current.required_status_checks);
      if (checks) delete checks.url;
      const restrictions = decoded(current.restrictions) == null ? null : object(current.restrictions);
      const identities = (value: unknown, key: string) =>
        z.array(z.record(z.string(), z.unknown())).parse(value ?? []).map((entry) => z.string().parse(entry[key]));
      const restricted = restrictions ? {
        users: identities(restrictions.users, "login"),
        teams: identities(restrictions.teams, "slug"),
        apps: identities(restrictions.apps, "slug"),
      } : null;
      // Response-only URLs and account objects are not accepted by the protection PUT.
      delete reviews.url;
      if (reviews.dismissal_restrictions) {
        const dismissal = object(reviews.dismissal_restrictions);
        reviews.dismissal_restrictions = {
          users: identities(dismissal.users, "login"), teams: identities(dismissal.teams, "slug"),
          apps: identities(dismissal.apps, "slug"),
        };
      }
      if (reviews.bypass_pull_request_allowances) {
        const bypass = object(reviews.bypass_pull_request_allowances);
        reviews.bypass_pull_request_allowances = {
          users: identities(bypass.users, "login"), teams: identities(bypass.teams, "slug"),
          apps: identities(bypass.apps, "slug"),
        };
      }
      reviews.required_approving_review_count = Math.max(z.number().int().nonnegative().parse(reviews.required_approving_review_count ?? 0), 1);
      const flags = ["required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations",
        "required_conversation_resolution", "lock_branch", "allow_fork_syncing"].filter((key) => decoded(current[key]) != null);
      return {
        sql: statement("mutations", "main_branch_protected", org, repo, {
          enforce_admins: enforceAdmins ? "true" : "false",
          reviews: lit(JSON.stringify(reviews)),
          checks: checks ? lit(JSON.stringify(checks)) : "null",
          restrictions: restricted ? lit(JSON.stringify(restricted)) : "null",
          extra_columns: flags.length ? `, ${flags.join(", ")}` : "",
          extra_values: flags.map((key) => `, ${bool(object(current[key]).enabled) ? "true" : "false"}`).join(""),
        }),
        verify: (after) => object(after.enforce_admins).enabled === enforceAdmins &&
          Number(object(after.required_pull_request_reviews).required_approving_review_count) >= Number(reviews.required_approving_review_count),
      };
    },
  },
};

export async function enable(check: string, org: string, repo: string): Promise<Record<string, unknown>> {
  const setting = SETTINGS[check];
  if (!setting) throw new Error(`no setting mutation for ${check}`);
  const prepared = setting.mutate ? await setting.mutate(org, repo) : { sql: statement("mutations", check, org, repo), verify: () => true };
  const output = await stackql.run(prepared.sql, stackql.WRITE_TOKEN_VAR);
  if (/http response status code: [45]\d\d|(?:^|\n)\s*(?:error|failed|fatal)\b/i.test(output.stderr)) {
    throw new stackql.StackQLError(output.stderr);
  }
  for (let attempt = 0; attempt < (check === "code_scanning" ? 6 : 1); attempt++) {
    const after = await setting.read(org, repo);
    if (setting.confirmed(after)) {
      if (!prepared.verify(after)) throw new Error(`${org}/${repo}: main read-back did not match the requested protection`);
      return after;
    }
    if (check === "code_scanning" && attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${org}/${repo}: ${check} mutation was not confirmed; no successful audit row recorded`);
}
