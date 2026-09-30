// Shared models. Column names match the findings schema in CLAUDE.md, so rows need no mapping.

import { z } from "zod";

export const Severity = z.enum(["high", "medium", "low"]);

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
