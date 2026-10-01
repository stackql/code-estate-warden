// Layer 4, report (deterministic): findings -> terminal table, markdown, job summary.

import { appendFileSync } from "node:fs";
import type { Evaluation } from "./evaluate.ts";
import type { Finding } from "./types.ts";

const STATUSES = ["pass", "fail", "na", "unknown"] as const;
const SEVERITY = { high: 0, medium: 1, low: 2 };

interface Summary {
  org: string;
  check_id: string;
  severity: Finding["severity"];
  counts: Record<(typeof STATUSES)[number], number>;
}

export interface Drift {
  failing: Finding[];
  passing: Finding[];
}

/** One row per org and check, sorted by org then severity then check. */
export function summarise(findings: Finding[]): Summary[] {
  const rows = new Map<string, Summary>();
  for (const f of findings) {
    const key = `${f.org}\t${f.check_id}`;
    const row = rows.get(key) ?? {
      org: f.org,
      check_id: f.check_id,
      severity: f.severity,
      counts: { pass: 0, fail: 0, na: 0, unknown: 0 },
    };
    row.counts[f.status]++;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.org.localeCompare(b.org) ||
      SEVERITY[a.severity] - SEVERITY[b.severity] ||
      a.check_id.localeCompare(b.check_id),
  );
}

/** Failures grouped by org, sorted by severity then repo. */
export const failures = (findings: Finding[]): Finding[] =>
  findings
    .filter((f) => f.status === "fail")
    .sort(
      (a, b) =>
        a.org.localeCompare(b.org) ||
        SEVERITY[a.severity] - SEVERITY[b.severity] ||
        a.repo.localeCompare(b.repo) ||
        a.check_id.localeCompare(b.check_id),
    );

/** Checks that fail now but did not before, and checks that pass now but failed before. */
export function drift(current: Evaluation, previous?: Evaluation): Drift {
  if (!previous) return { failing: [], passing: [] };
  const key = (f: Finding) => `${f.org}/${f.repo}:${f.check_id}`;
  const before = new Map(previous.findings.map((f) => [key(f), f.status]));
  return {
    failing: failures(current.findings).filter((f) => before.get(key(f)) !== "fail"),
    passing: current.findings.filter((f) => f.status === "pass" && before.get(key(f)) === "fail"),
  };
}

const table = (header: string[], rows: string[][]): string => {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
};

export function terminal(evaluation: Evaluation, change: Drift): string {
  const rows = summarise(evaluation.findings).map((s) => [
    s.org,
    s.check_id,
    s.severity,
    ...STATUSES.map((st) => String(s.counts[st])),
  ]);
  const out = [`run ${evaluation.run_id} observed ${evaluation.observed_at}`, ""];
  out.push(table(["org", "check", "severity", ...STATUSES], rows));
  const list = (title: string, items: Finding[]) => {
    if (items.length) out.push("", `${title} (${items.length})`, ...items.map((f) => `  ${f.org}/${f.repo}  ${f.check_id}`));
  };
  list("newly failing", change.failing);
  list("newly passing", change.passing);
  return out.join("\n");
}

export function markdown(evaluation: Evaluation, change: Drift): string {
  const out = [`## code-estate-warden ${evaluation.run_id}`, "", `Observed ${evaluation.observed_at}.`, ""];
  out.push(`| org | check | severity | ${STATUSES.join(" | ")} |`, `|---|---|---|${"---:|".repeat(STATUSES.length)}`);
  for (const s of summarise(evaluation.findings)) {
    out.push(`| ${s.org} | ${s.check_id} | ${s.severity} | ${STATUSES.map((st) => s.counts[st]).join(" | ")} |`);
  }
  const list = (title: string, items: Finding[]) => {
    if (!items.length) return;
    out.push("", `<details><summary>${title} (${items.length})</summary>`, "");
    out.push(...items.map((f) => `- ${f.org}/${f.repo} ${f.check_id} (${f.severity})`), "", "</details>");
  };
  list("Newly failing", change.failing);
  list("Newly passing", change.passing);
  list("All failing", failures(evaluation.findings));
  return out.join("\n") + "\n";
}

export const MATRIX_LEGEND =
  "Cells are failing / assessed. Assessed leaves out archived and exempt repositories. N? is repositories the token could not see. Organization level controls show the status of each organization.";

/**
 * The estate on one screen: one row per control, one column per org and one for all of them.
 * A markdown table, with the legend under it.
 */
export function matrix(findings: Finding[]): string {
  const summary = summarise(findings);
  const orgs = [...new Set(summary.map((s) => s.org))];
  const controls = [...new Map(summary.map((s) => [s.check_id, s.severity]))].sort(
    (a, b) => SEVERITY[a[1]] - SEVERITY[b[1]] || a[0].localeCompare(b[0]),
  );
  const orgLevel = new Set(findings.filter((f) => f.repo === "*").map((f) => f.check_id));
  const ratio = (fail: number, assessed: number, unknown: number) =>
    [assessed ? `${fail}/${assessed}` : "", unknown ? `${unknown}?` : ""].filter(Boolean).join(" ") || "-";
  const rows = controls.map(([check, severity]) => {
    const perOrg = orgs.map((org) => summary.find((s) => s.org === org && s.check_id === check)?.counts);
    const sum = (status: (typeof STATUSES)[number]) => perOrg.reduce((n, c) => n + (c?.[status] ?? 0), 0);
    const cells = perOrg.map((c) => {
      if (!c) return "-";
      if (orgLevel.has(check)) return STATUSES.find((status) => status !== "na" && c[status]) ?? "na";
      return ratio(c.fail, c.pass + c.fail, c.unknown);
    });
    return `| ${check} | ${severity} | ${cells.join(" | ")} | ${ratio(sum("fail"), sum("pass") + sum("fail"), sum("unknown"))} |`;
  });
  const header = `| control | severity | ${orgs.join(" | ")} | all |`;
  return [header, `|---|---|${"---:|".repeat(orgs.length + 1)}`, ...rows, "", MATRIX_LEGEND].join("\n");
}

/** Append the markdown to the GitHub Actions job summary when running in Actions. */
export function jobSummary(content: string): boolean {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  appendFileSync(path, content);
  return true;
}
