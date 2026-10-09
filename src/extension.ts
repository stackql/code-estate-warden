// Copilot CLI front end: the deterministic layers and the planning tools as extension tools, plus
// the hook that keeps GitHub writes inside the apply tool. Loaded by
// .github/extensions/code-estate-warden/extension.mjs when the Copilot CLI starts in this repository.
//
// The runtime here is the person in the CLI. They say when to snapshot, evaluate, plan and apply,
// and a turn is one prompt however many tool calls it takes. State lives in this process for the
// length of the session.

import { existsSync } from "node:fs";
import type { SessionHooks } from "@github/copilot-sdk";
import { z } from "zod";
import { acceptManifest, compileBrief, tools, type AgentTool } from "./agent.ts";
import type { Config } from "./config.ts";
import { evaluate, previousEvaluation, type Evaluation } from "./evaluate.ts";
import { apply, loadPlan, noteSummary, planBrief, planPath, renderPlan, savePlan } from "./remediate.ts";
import { drift, matrix } from "./report.ts";
import { snapshot } from "./snapshot.ts";
import * as stackql from "./stackql.ts";
import { type ChangeItem, type Finding, Manifest } from "./types.ts";
import { Selection, select } from "./selection.ts";

/** Recorded as the model of a plan made here. The CLI picks the model, not the config. */
export const MODEL = "copilot-cli";

const LIMIT = 50;

export interface State {
  evaluation?: Evaluation;
  changes: ChangeItem[];
  summaries: Record<string, string>;
}

export const newState = (): State => ({ changes: [], summaries: {} });

const EMPTY: Evaluation = { run_id: "", observed_at: "", findings: [] };

/** The token variables to ask the CLI for: the ones .env did not provide. */
export const tokensToRequest = (env: NodeJS.ProcessEnv = process.env): string[] =>
  [stackql.READ_TOKEN_VAR, stackql.WRITE_TOKEN_VAR].filter((name) => !env[name]);

/** Every tool the CLI gets. The planning tools are the SDK agent's, bound to the current evaluation on each call. */
export function extensionTools(config: Config, state: State, log: (line: string) => void = () => {}): AgentTool[] {
  const current = (): Evaluation => {
    if (!state.evaluation) throw new Error("no evaluation in this session yet, call evaluate first");
    return state.evaluation;
  };
  const reset = (evaluation?: Evaluation) => {
    state.evaluation = evaluation;
    state.changes.length = 0;
    state.summaries = {};
  };
  const allowed = (org: string) => {
    if (!config.orgs.includes(org)) throw new Error(`${org} is not in the org allowlist`);
  };
  const names = (items: Finding[]) => ({ total: items.length, findings: items.slice(0, LIMIT).map((f) => `${f.org}/${f.repo} ${f.check_id}`) });
  const planned = () => {
    const runId = current().run_id;
    if (!existsSync(planPath(runId))) throw new Error("no plan for this run yet, propose changes and call finish_plan");
    return loadPlan(runId);
  };
  // agent.ts binds its tools to one evaluation; here the evaluation changes, so bind on each call.
  // list_checks reads no run, so it works before the first evaluate.
  const planning: AgentTool[] = tools({ config, evaluation: EMPTY, changes: state.changes }).map((t) => ({
    ...t,
    handler: (args: unknown) => {
      const evaluation = t.name === "list_checks" ? EMPTY : current();
      return tools({ config, evaluation, changes: state.changes }).find((x) => x.name === t.name)!.handler(args);
    },
  }));

  return [
    {
      name: "snapshot",
      description: "Take a fresh inventory snapshot with StackQL, for an exact repo (org/repo or GitHub URL), one org, or every configured org. It becomes the latest run; call evaluate next with the same scope. core selects the core five plus SECURITY.md.",
      parameters: Selection,
      handler: async (input: Selection) => {
        const started = Date.now();
        const scope = select(config, input);
        const result = await snapshot(config, log, scope);
        reset();
        return { run_id: result.run_id, repos: result.repos, orgs: scope.org ? [scope.org] : config.orgs, seconds: Math.round((Date.now() - started) / 1000), next: "call evaluate" };
      },
    },
    {
      name: "evaluate",
      description: "Evaluate a snapshot, latest by default, for an exact repo, one org or all orgs; core selects the core five plus SECURITY.md. Returns scoped repository counts, a markdown table and drift. It becomes the current evaluation and drops any unfinished plan.",
      parameters: Selection.extend({ run_id: z.string().optional().describe("a run id from runs/, default the latest snapshot") }),
      handler: ({ run_id, ...scope }: Selection & { run_id?: string }) => {
        const evaluation = evaluate(config, run_id, undefined, scope);
        reset(evaluation);
        const change = drift(evaluation, previousEvaluation(evaluation.run_id));
        const inventory = planning.find((t) => t.name === "get_snapshot_summary")!.handler({}) as { orgs: unknown };
        return {
          run_id: evaluation.run_id,
          observed_at: evaluation.observed_at,
          inventory: inventory.orgs,
          table: matrix(evaluation.findings),
          newly_failing: names(change.failing),
          newly_passing: names(change.passing),
        };
      },
    },
    {
      name: "policy_brief",
      description: "The instructions for compiling policy/core-controls.md into a manifest, with the available checks. Follow them, then call save_manifest.",
      parameters: z.object({}),
      handler: () => compileBrief(),
    },
    {
      name: "save_manifest",
      description: "Save the compiled policy as policy/manifest.json. Unknown check ids are refused. Call evaluate again afterwards so the exemptions apply.",
      parameters: z.object({ manifest: Manifest }),
      handler: ({ manifest }: { manifest: Manifest }) => ({ saved: acceptManifest(manifest).checks.map((c) => c.id), next: "call evaluate" }),
    },
    {
      name: "plan_brief",
      description: "The remediation planning instructions for one org of the current run: its failing checks, its security configurations and the policy. Follow them with propose_change, then call finish_plan.",
      parameters: z.object({ org: z.string() }),
      handler: ({ org }: { org: string }) => {
        allowed(org);
        return planBrief(org, current()) ?? `nothing fails in ${org}, there is nothing to plan`;
      },
    },
    ...planning,
    {
      name: "finish_plan",
      description: "Record the summary for an org and write the change set to runs/<run_id>.plan.json. Once per org, after its proposals.",
      parameters: z.object({ org: z.string(), summary: z.string(), left_out: z.array(z.string()).default([]).describe("what was not proposed and why") }),
      handler: ({ org, summary, left_out }: { org: string; summary: string; left_out: string[] }) => {
        allowed(org);
        state.summaries[org] = noteSummary(summary, left_out);
        return renderPlan(savePlan(current().run_id, MODEL, state.changes, state.summaries, current().selection));
      },
    },
    {
      name: "show_plan",
      description: "The change set written for the current run, one line per group of repos that get the same change.",
      parameters: z.object({}),
      handler: () => renderPlan(planned()),
    },
    {
      name: "apply",
      description: `Apply the plan of the current run. A dry run unless apply is true, which the person must have asked for in this turn. Applying changes settings for ${config.apply_checks.join(", ")}, creates or updates issues, needs ${stackql.WRITE_TOKEN_VAR}, and audits every change.`,
      parameters: Selection.extend({
        apply: z.boolean().default(false).describe("false shows what would be done, true makes the changes"),
        filter: z.string().optional().describe("only changes whose key contains this text, such as org/repo or a check id"),
        assign_copilot: z.boolean().default(false).describe("assign issues for file changes to the Copilot coding agent"),
      }),
      handler: async ({ apply: write, filter, assign_copilot, ...scope }: Selection & { apply: boolean; filter?: string; assign_copilot: boolean }) => {
        const outcomes = await apply(config, planned(), current(), { apply: write, assignCopilot: assign_copilot, filter, selection: scope }, log);
        const count = (result: string) => outcomes.filter((o) => o.result === result).length;
        return { dry_run: !write, applied: count("applied"), planned: count("planned"), skipped: count("skipped"), outcomes };
      },
    },
  ];
}

export interface ToolFailure {
  textResultForLlm: string;
  resultType: "failure";
}

/** A tool in the shape joinSession takes: JSON schema in, text out. */
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: unknown) => Promise<string | ToolFailure>;
}

/**
 * zod still validates the arguments, so defaults apply. An error is returned as a failure with
 * its reason: a thrown one reaches the model as "Tool execution failed" and nothing else.
 */
export function extensionTool(tool: AgentTool): ExtensionTool {
  const parameters = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
  delete parameters.$schema;
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    handler: async (args) => {
      try {
        const result = await tool.handler(tool.parameters.parse(args ?? {}));
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (e) {
        const reason = e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e);
        return { textResultForLlm: reason, resultType: "failure" };
      }
    },
  };
}

export interface ToolCall {
  toolName: string;
  toolArgs: unknown;
}

export interface Decision {
  permissionDecision: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
}

const SHELL = new Set(["bash", "powershell", "shell"]);
const WRITE = new Set(["create", "edit", "write", "str_replace_editor"]);
// a mutating statement handed to stackql, a non GET gh api call, a gh subcommand that writes, or our own --apply
const GITHUB_WRITE = /--apply\b|\bstackql\b[\s\S]*\b(insert\s+into|delete\s+from|update\s+[\w.]+\s+set|exec\s+\w+\.\w+)|\bgh\s+api\b[\s\S]*(-X|--method)\s+(?!get\b)|\bgh\s+\w+\s+(create|edit|close|delete|comment|merge)\b/i;
const OWNED = /(^|[\\/])(runs[\\/]|\.env$|policy[\\/]manifest\.json$)/i;

/**
 * Our own tools run without a prompt, except the two a person should see first: a real apply and
 * a new manifest. GitHub is written only through the apply tool, and the run files only by the
 * tools. Everything else is left to the prompts of the CLI.
 */
export function beforeTool({ toolName, toolArgs }: ToolCall, own: ReadonlySet<string> = new Set()): Decision | undefined {
  const args = (toolArgs ?? {}) as Record<string, unknown>;
  if (toolName === "apply" && args.apply === true) return { permissionDecision: "ask", permissionDecisionReason: "apply writes to GitHub" };
  if (toolName === "save_manifest" && own.has(toolName)) return { permissionDecision: "ask", permissionDecisionReason: "save_manifest replaces policy/manifest.json" };
  if (own.has(toolName)) return { permissionDecision: "allow" };
  if (SHELL.has(toolName) && GITHUB_WRITE.test(String(args.command ?? ""))) {
    return { permissionDecision: "deny", permissionDecisionReason: "GitHub is only written through the apply tool, which confirms and audits every change" };
  }
  if (WRITE.has(toolName) && OWNED.test(String(args.path ?? ""))) {
    return { permissionDecision: "deny", permissionDecisionReason: "run files, the manifest and .env are written by the code-estate-warden tools, not edited" };
  }
  return undefined;
}

/** The session hooks, given the names of the tools this extension registered. */
export function hooksFor(own: Iterable<string>): SessionHooks {
  const names = new Set(own);
  return { onPreToolUse: (input) => beforeTool(input, names) };
}
