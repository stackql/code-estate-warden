import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, mock, test } from "node:test";
import { Config } from "../src/config.ts";
import { MODEL, beforeTool, extensionTool, extensionTools, hooksFor, newState, tokensToRequest, type State } from "../src/extension.ts";
import { loadPlan } from "../src/remediate.ts";
import * as stackql from "../src/stackql.ts";
import { load, readFixture } from "./fixture.ts";

const root = join(import.meta.dirname, "..");
const config = Config.parse({ enterprise: "acme", orgs: ["acme", "beta"], exclude_repos: ["beta/skip"], model: "m" });
const RUN = "01FIXTURE0000000000000000A";
const cwd = process.cwd();
let work: string;
let state: State;

before(() => {
  work = mkdtempSync(join(tmpdir(), "warden-"));
  mkdirSync(join(work, "runs"));
  load(readFixture("snapshot").tables, join(work, "runs", `${RUN}.db`)).close();
  process.chdir(work);
  state = newState();
});

after(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
});

afterEach(() => mock.restoreAll());

const registered = () => extensionTools(config, state).map(extensionTool);

/** Call a tool the way the CLI does: raw arguments in, text or a failure out. */
const raw = async (name: string, args: unknown = {}) => {
  const tool = registered().find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.handler(args);
};
/** The text of a successful call; a failure is thrown with its reason. */
const call = async (name: string, args: unknown = {}): Promise<string> => {
  const result = await raw(name, args);
  if (typeof result !== "string") throw new Error(result.textResultForLlm);
  return result;
};
const json = async (name: string, args: unknown = {}) => JSON.parse(await call(name, args));

const proposal = { action: "pr", check_id: "security_md", org: "acme", repos: ["bad"], target: "SECURITY.md", after: "SECURITY.md present", reason: "policy" };

test("the extension registers the verbs and the planning tools with JSON schema parameters", () => {
  const tools = registered();
  assert.deepEqual(tools.map((t) => t.name), [
    "snapshot", "evaluate", "policy_brief", "save_manifest", "plan_brief",
    "list_checks", "get_snapshot_summary", "run_check", "get_findings", "propose_change",
    "finish_plan", "show_plan", "apply",
  ]);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.ok(!("$schema" in tool.parameters), tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  const propose = tools.find((t) => t.name === "propose_change")!;
  assert.deepEqual(propose.parameters.required, ["action", "check_id", "org", "repos", "target", "after", "reason"]);
});

test("tools that read findings need an evaluation first, and say so as a failure the model can read", async () => {
  assert.deepEqual(await raw("get_findings"), { textResultForLlm: "no evaluation in this session yet, call evaluate first", resultType: "failure" });
  await assert.rejects(call("plan_brief", { org: "acme" }), /call evaluate first/);
  await assert.rejects(call("apply"), /call evaluate first/);
  assert.ok((await json("list_checks")).length > 0, "list_checks reads no run");
});

test("evaluate returns counts and drift, plan_brief the instructions for an allowed org", async () => {
  const result = await json("evaluate", { run_id: RUN });
  assert.equal(result.run_id, RUN);
  assert.deepEqual(result.inventory.map((o: { org: string; repos: number }) => [o.org, o.repos]), [["acme", 3], ["beta", 1]]);
  assert.match(result.table, /^\| control \| severity \| acme \| beta \| all \|\n/);
  assert.match(result.table, /\| secret_scanning \| medium \| 1\/2 \| - \| 1\/2 \|/, "one row per control, failing out of assessed");
  assert.match(result.table, /Cells are failing \/ assessed/);
  assert.deepEqual(Object.keys(result.newly_failing), ["total", "findings"]);
  assert.ok(!("report" in result) && !("findings" in result), "no full report in the model's context");
  assert.equal(state.evaluation?.run_id, RUN);

  const brief = await call("plan_brief", { org: "acme" });
  assert.match(brief, /organization acme[\s\S]*- security_md \(/);
  assert.match(brief, /propose_change/);
  await assert.rejects(call("plan_brief", { org: "other" }), /other is not in the org allowlist/);
  assert.deepEqual((await json("run_check", { check_id: "secret_scanning" })).failing, ["acme/bad"]);
});

test("proposals accumulate, finish_plan writes the change set, apply is a dry run unless told", async () => {
  const spawned = mock.method(stackql.io, "spawn", async () => ({ stdout: "null", stderr: "" }));
  delete process.env[stackql.WRITE_TOKEN_VAR];
  await assert.rejects(call("show_plan"), /no plan for this run yet, propose changes and call finish_plan/);
  await assert.rejects(call("apply"), /no plan for this run yet/);
  assert.deepEqual(await json("propose_change", proposal), { added: ["acme/bad:security_md:pr"] });
  assert.deepEqual(await json("propose_change", { ...proposal, repos: ["old"] }), { refused: "acme/old is archived" });
  await assert.rejects(call("propose_change", { ...proposal, action: "rewrite" }), /action/, "zod validates the arguments");

  const text = await call("finish_plan", { org: "acme", summary: "one file change" });
  assert.match(text, /plan 01FIXTURE0000000000000000A, 1 changes[\s\S]*acme: one file change/);
  const plan = loadPlan(RUN);
  assert.equal(plan.model, MODEL);
  assert.deepEqual(plan.items.map((i) => i.key), ["acme/bad:security_md:pr"]);
  assert.equal(await call("show_plan"), text);
  await assert.rejects(call("finish_plan", { org: "other", summary: "x" }), /not in the org allowlist/);

  const dry = await json("apply");
  assert.deepEqual([dry.dry_run, dry.applied, dry.planned], [true, 0, 1]);
  assert.equal(spawned.mock.callCount(), 0, "a dry run spawns nothing");
  await assert.rejects(call("apply", { apply: true }), /CODE_ESTATE_WARDEN_WRITE_TOKEN is not set/);

  await json("evaluate", { run_id: RUN });
  assert.equal(state.changes.length, 0, "a new evaluation drops the unfinished plan");
});

test("save_manifest refuses unknown checks and malformed manifests before writing", async () => {
  assert.match(await call("policy_brief"), /Available checks:[\s\S]*- secret_scanning:/);
  await assert.rejects(call("save_manifest", { manifest: { checks: [{ id: "made_up" }] } }), /unknown checks: made_up/);
  await assert.rejects(call("save_manifest", { manifest: { checks: [] } }));
});

test("the hook keeps GitHub writes in the apply tool and the run files in the tools", () => {
  const own = new Set(registered().map((t) => t.name));
  const decide = (toolName: string, toolArgs: unknown) => beforeTool({ toolName, toolArgs }, own)?.permissionDecision;
  assert.equal(decide("apply", { apply: true }), "ask", "a real apply always asks");
  assert.equal(decide("save_manifest", { manifest: {} }), "ask", "so does a new manifest");
  for (const name of ["apply", "snapshot", "evaluate", "get_findings", "propose_change", "finish_plan"]) {
    assert.equal(decide(name, {}), "allow", `${name} runs without a prompt`);
  }
  assert.equal(beforeTool({ toolName: "apply", toolArgs: { apply: true } })?.permissionDecision, "ask", "even when the tool names are unknown");
  const hook = hooksFor(own).onPreToolUse!;
  assert.deepEqual(hook({ toolName: "evaluate", toolArgs: {}, timestamp: new Date(), workingDirectory: "." } as Parameters<typeof hook>[0], { sessionId: "s" }), { permissionDecision: "allow" });

  for (const command of [
    "node src/cli.ts apply --apply",
    `stackql exec "INSERT INTO github.issues.issues(owner, repo, title) SELECT 'a', 'b', 'c'"`,
    `stackql exec "EXEC github.repos.private_vulnerability_reporting.enable_private_vulnerability_reporting @owner = 'a'"`,
    "gh api -X POST repos/acme/bad/issues -f title=x",
    "gh api repos/acme/bad --method PATCH -f has_issues=false",
    "gh issue create --title x",
  ]) {
    assert.equal(decide("bash", { command }), "deny", command);
    assert.equal(decide("powershell", { command }), "deny", command);
  }
  for (const command of ["git status", "npm test", "node src/cli.ts apply", `stackql exec "SELECT name FROM github.repos.repos WHERE org = 'acme'"`, "gh api orgs/acme", "gh api -X GET orgs/acme", "gh issue list"]) {
    assert.equal(decide("bash", { command }), undefined, command);
  }

  for (const path of ["runs/01X.plan.json", ".env", "C:\\repo\\policy\\manifest.json", "/repo/runs/01X.db"]) {
    assert.equal(decide("edit", { path }), "deny", path);
    assert.equal(decide("create", { path }), "deny", path);
  }
  for (const path of ["src/agent.ts", "policy/core-controls.md", ".env.example", "test/runs.test.ts"]) {
    assert.equal(decide("edit", { path }), undefined, path);
  }
  assert.equal(decide("view", { path: "runs/01X.json" }), undefined, "reading is not the hook's business");
});

test("only the tokens .env did not provide are requested from the CLI", () => {
  assert.deepEqual(tokensToRequest({}), [stackql.READ_TOKEN_VAR, stackql.WRITE_TOKEN_VAR]);
  assert.deepEqual(tokensToRequest({ [stackql.READ_TOKEN_VAR]: "t" }), [stackql.WRITE_TOKEN_VAR]);
  assert.deepEqual(tokensToRequest({ [stackql.READ_TOKEN_VAR]: "t", [stackql.WRITE_TOKEN_VAR]: "w" }), []);
});

test("the agent file, the shim and the MCP config stay in step with the code", () => {
  const agent = readFileSync(join(root, ".github/agents/code-estate-warden.agent.md"), "utf8");
  const listed = [...agent.split("---")[1]!.matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]);
  for (const tool of registered()) assert.ok(listed.includes(tool.name), `agent file lists ${tool.name}`);
  assert.ok(!listed.includes("bash") && !listed.includes("edit"), "the agent gets no shell and no file writes");

  const shim = join(root, ".github/extensions/code-estate-warden/extension.mjs");
  assert.equal(spawnSync(process.execPath, ["--check", shim], { encoding: "utf8" }).status, 0, "the shim parses");
  const source = readFileSync(shim, "utf8");
  assert.match(source, /hooksFor\(tools\.map\(\(t\) => t\.name\)\)/);
  assert.match(source, /joinSession\(\{ tools, hooks, requestedEnvironmentVariables: tokensToRequest\(\) \}\)/);

  const names = new Set(registered().map((t) => t.name));
  for (const [skill, uses] of [["evaluate", ["snapshot", "evaluate"]], ["remediate", ["plan_brief", "propose_change", "finish_plan", "apply"]]] as const) {
    const [, front, body] = readFileSync(join(root, `.github/skills/${skill}/SKILL.md`), "utf8").split(/^---$/m);
    assert.match(front!, new RegExp(`^name: ${skill}$`, "m"));
    assert.match(front!, /^user-invocable: true$/m, `/${skill} is a slash command`);
    for (const tool of uses) assert.ok(body!.includes(`\`${tool}\``), `/${skill} uses ${tool}`);
    for (const [, word] of body!.matchAll(/`([a-z]+_[a-z_]+)`/g)) assert.ok(names.has(word!), `/${skill} names a tool that exists: ${word}`);
  }

  // named stackql so that, in this repository, it replaces a user level server of the same name
  const mcp = JSON.parse(readFileSync(join(root, ".github/mcp.json"), "utf8")).mcpServers.stackql;
  assert.deepEqual(mcp.args, [...stackql.mcpServer().args, "--env.file", ".env"], "the same read only server the SDK agent gets");
  assert.ok(mcp.tools.includes("run_select_query") && !mcp.tools.some((t: string) => /mutation|lifecycle|pull_provider|reload|\*/.test(t)), "only the read tools");
  for (const tool of mcp.tools) assert.ok(listed.includes(tool), `agent file lists ${tool}`);
});
