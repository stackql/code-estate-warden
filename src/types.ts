// Shared models. Column names match the findings schema in AGENTS.md, so rows need no mapping.

import { z } from "zod";

export const Severity = z.enum(["high", "medium", "low"]);

export const RepoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected org/repo");

export const Finding = z.strictObject({
  run_id: z.string(),
  org: z.string(),
  repo: z.string(),
  check_id: z.string(),
  status: z.enum(["pass", "fail", "na", "unknown"]),
  severity: Severity,
  evidence: z.record(z.string(), z.unknown()),
  remediation: z.enum(["setting", "issue", "pr", "manual", "none"]),
  observed_at: z.iso.datetime(),
});

export type Finding = z.infer<typeof Finding>;

/** The policy compiled to something deterministic: which checks run and who is exempt. */
export const Manifest = z.strictObject({
  checks: z
    .array(
      z.strictObject({
        id: z.string(),
        scope: z.enum(["all", "public"]).default("all"),
        exempt_forks: z.boolean().default(false),
        exempt: z.array(RepoName).default([]),
      }),
    )
    .min(1),
});

export type Manifest = z.infer<typeof Manifest>;

/** One proposed change. The key makes plan and apply idempotent. */
export const ChangeItem = z.strictObject({
  key: z.string(),
  action: z.enum(["setting", "issue", "pr", "manual"]),
  org: z.string(),
  /** "*" for an organization level change */
  repo: z.string(),
  check_id: z.string(),
  target: z.string(),
  before: z.unknown(),
  after: z.string(),
  reason: z.string(),
});

export type ChangeItem = z.infer<typeof ChangeItem>;
