// AgentRuntime interface, the Copilot SDK session, tools, and the permission handler.
//
// Every agentic step is one prompt with one structured reply, and each costs one premium request
// on Copilot. Tools wrap the deterministic layers and write nowhere except the change set. The
// runtime is an interface so a test fake or another provider can stand in without touching the
// other layers.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CopilotClient, defineTool, type PermissionHandler } from "@github/copilot-sdk";
import { z } from "zod";
import type { Config } from "./config.ts";
import { checkIds, checks, runCheck, saveManifest, type Evaluation } from "./evaluate.ts";
import { dbPath } from "./snapshot.ts";
import * as stackql from "./stackql.ts";
import { ChangeItem, type Finding, Manifest } from "./types.ts";

const INSTRUCTIONS = fileURLToPath(new URL("../instructions", import.meta.url));
const POLICY = fileURLToPath(new URL("../policy/core-controls.md", import.meta.url));
const TIMEOUT_MS = 10 * 60 * 1000;
const LIMIT = 200;

/** A prompt file with {{name}} placeholders filled in. */
export function instruction(name: string, vars: Record<string, string> = {}): string {
  const text = readFileSync(`${INSTRUCTIONS}/${name}.md`, "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`${name}.md: no value for {{${key}}}`);
    return vars[key]!;
  });
}

// any: the tool list mixes parameter types, each handler is typed by its own schema
export interface AgentTool<T = any> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  handler: (args: T) => unknown;
}

export interface Ask<T> {
  prompt: string;
  tools: AgentTool[];
  schema: z.ZodType<T>;
}

export interface AgentRuntime {
  /** One prompt, one structured reply. */
  ask<T>(request: Ask<T>): Promise<T>;
}

/** Approve our own tools and read only MCP calls. Everything else, shell and file writes included, is refused. */
export const permissionHandler: PermissionHandler = (request) => {
  if (request.kind === "custom-tool") return { kind: "approve-once" };
  if (request.kind === "mcp" && request.readOnly) return { kind: "approve-once" };
  return { kind: "reject", feedback: `${request.kind} is not allowed, propose changes with propose_change` };
};

export class CopilotRuntime implements AgentRuntime {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async ask<T>({ prompt, tools, schema }: Ask<T>): Promise<T> {
    const client = new CopilotClient({ gitHubToken: process.env.COPILOT_GITHUB_TOKEN, logLevel: "error" });
    try {
      const models = await client.listModels();
      if (!models.some((m) => m.id === this.config.model)) {
        const available = models.map((m) => `  ${m.id} (${m.billing?.multiplier ?? "?"}x)`).join("\n");
        throw new Error(`model ${this.config.model} is not available, set one of:\n${available}`);
      }
      const session = await client.createSession({
        model: this.config.model,
        systemMessage: { mode: "append", content: instruction("system_prompt") },
        tools: tools.map((t) => defineTool(t.name, { description: t.description, parameters: t.parameters, handler: t.handler })),
        mcpServers: { stackql: stackql.mcpServer() },
        onPermissionRequest: permissionHandler,
        streaming: false,
      });
      try {
        return await session.sendAndWait({ prompt }, schema, TIMEOUT_MS);
      } finally {
        await session.disconnect();
      }
    } finally {
      await client.stop();
    }
  }
}

/** Compile policy/core-controls.md into policy/manifest.json. One prompt. Unknown check ids are refused. */
export async function compilePolicy(runtime: AgentRuntime, policy = readFileSync(POLICY, "utf8"), save = saveManifest): Promise<Manifest> {
  const list = checks().map((c) => `- ${c.id}: ${c.description}`).join("\n");
  const manifest = await runtime.ask({ prompt: instruction("compile_policy", { checks: list, policy }), tools: [], schema: Manifest });
  const unknown = manifest.checks.map((c) => c.id).filter((id) => !checkIds().includes(id));
  if (unknown.length) throw new Error(`policy names unknown checks: ${unknown.join(", ")}`);
  save(manifest);
  return manifest;
}

const Proposal = z.object({
  action: z.enum(["setting", "issue", "pr", "manual"]),
  check_id: z.string(),
  org: z.string(),
  repos: z.array(z.string()).min(1).describe('repository names in the org, or ["*"] for one organization level change'),
  target: z.string().describe("what changes: the setting, the file to add, or the configuration to attach"),
  after: z.string().describe("the desired state"),
  reason: z.string(),
});

export interface PlanContext {
  config: Config;
  evaluation: Evaluation;
  changes: ChangeItem[];
}

const compact = (f: Finding) => ({ org: f.org, repo: f.repo, check_id: f.check_id, status: f.status, severity: f.severity, evidence: f.evidence });

/** The tools the agent gets for planning. propose_change is the only one with a side effect. */
export function tools({ config, evaluation, changes }: PlanContext): AgentTool[] {
  // open per call, so no handle outlives the tool
  const query = <T>(fn: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dbPath(evaluation.run_id), { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const orgs = new Set(config.orgs.map((o) => o.toLowerCase()));
  const excluded = new Set(config.exclude_repos.map((r) => r.toLowerCase()));
  const archived = new Set(
    query((db) => db.prepare("SELECT org, name FROM repos WHERE archived = 1").all() as { org: string; name: string }[]).map((r) => `${r.org}/${r.name}`.toLowerCase()),
  );
  const finding = (org: string, repo: string, check: string) =>
    evaluation.findings.find((f) => f.org === org && f.repo === repo && f.check_id === check);

  const list: AgentTool[] = [
    {
      name: "list_checks",
      description: "Every check repo-warden knows, with what it looks at.",
      parameters: z.object({}),
      handler: () => checks(),
    },
    {
      name: "get_snapshot_summary",
      description: "When the snapshot was taken, by whom, and repo counts per org.",
      parameters: z.object({}),
      handler: () =>
        query((db) => ({
          run: db.prepare("SELECT run_id, finished_at AS observed_at, login, orgs FROM run").get(),
          orgs: db.prepare("SELECT org, count(*) AS repos, sum(archived) AS archived, sum(private) AS private, sum(fork) AS forks FROM repos GROUP BY org").all(),
        })),
    },
    {
      name: "run_check",
      description: "Run one check against the snapshot: counts per status and the failing repos.",
      parameters: z.object({ check_id: z.string() }),
      handler: ({ check_id }: { check_id: string }) => {
        if (!checkIds().includes(check_id)) return { error: `unknown check ${check_id}` };
        const run = { run_id: evaluation.run_id, observed_at: evaluation.observed_at };
        const rows = query((db) => runCheck(db, check_id, run, config)).filter((r) => !excluded.has(`${r.org}/${r.repo}`.toLowerCase()));
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
        const failing = rows.filter((r) => r.status === "fail").map((r) => `${r.org}/${r.repo}`);
        return { counts, failing: failing.slice(0, LIMIT), failing_total: failing.length };
      },
    },
    {
      name: "get_findings",
      description: `Findings filtered by org, check_id or status, at most ${LIMIT} with the total.`,
      parameters: z.object({ org: z.string().optional(), check_id: z.string().optional(), status: z.enum(["pass", "fail", "na", "unknown"]).optional() }),
      handler: (filter: { org?: string; check_id?: string; status?: string }) => {
        const matching = evaluation.findings.filter(
          (f) => (!filter.org || f.org === filter.org) && (!filter.check_id || f.check_id === filter.check_id) && (!filter.status || f.status === filter.status),
        );
        return { total: matching.length, findings: matching.slice(0, LIMIT).map(compact) };
      },
    },
    {
      name: "propose_change",
      description: "Add a change to the plan for one or more repos of an org, or for the org itself. Nothing is applied.",
      parameters: Proposal,
      handler: (p: z.infer<typeof Proposal>) => {
        if (!orgs.has(p.org.toLowerCase())) return { refused: `${p.org} is not in the org allowlist` };
        if (!checkIds().includes(p.check_id)) return { refused: `unknown check ${p.check_id}` };
        if (/\b(disable|disabled|off|false|remove|delete)\b/i.test(p.after)) return { refused: "a control is never disabled" };
        const added: string[] = [];
        for (const repo of p.repos) {
          const name = `${p.org}/${repo}`;
          if (archived.has(name.toLowerCase())) return { refused: `${name} is archived` };
          if (excluded.has(name.toLowerCase())) return { refused: `${name} is excluded by config` };
          const failing = repo === "*"
            ? evaluation.findings.find((f) => f.org === p.org && f.check_id === p.check_id && f.status === "fail")
            : finding(p.org, repo, p.check_id);
          if (!failing || failing.status !== "fail") return { refused: `${name} does not fail ${p.check_id}` };
          const key = `${name}:${p.check_id}:${p.action}`;
          const item = ChangeItem.parse({ key, action: p.action, org: p.org, repo, check_id: p.check_id, target: p.target, before: failing.evidence, after: p.after, reason: p.reason });
          const existing = changes.findIndex((c) => c.key === key);
          if (existing >= 0) changes[existing] = item;
          else changes.push(item);
          added.push(key);
        }
        return { added };
      },
    },
  ];
  return list;
}
