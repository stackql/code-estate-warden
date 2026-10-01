// Thin wrapper around the stackql binary. The only module that spawns it.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

export const PROVIDER = "github";
export const READ_TOKEN_VAR = "CODE_ESTATE_WARDEN_READ_TOKEN";
export const WRITE_TOKEN_VAR = "CODE_ESTATE_WARDEN_WRITE_TOKEN";

const APPROOT = ".stackql";
const EXE = process.platform === "win32" ? "stackql.exe" : "stackql";
const LOCAL = join(APPROOT, EXE);
const RELEASES = "https://releases.stackql.io/stackql/latest";

/** Every value comes back as a string, booleans and numbers included. */
export type Row = Record<string, string>;

export interface Output {
  stdout: string;
  stderr: string;
}

export class StackQLError extends Error {}

// indirection so tests can replace the process spawn
export const io = { spawn: promisify(execFile) };

/** The copy bootstrap downloaded if there is one, otherwise whatever is on PATH. */
export const binary = (): string => (existsSync(LOCAL) ? LOCAL : "stackql");

/** First line of `stackql --version`, or undefined when the binary is missing. */
export async function version(): Promise<string | undefined> {
  try {
    const { stdout } = await io.spawn(binary(), ["--version"]);
    return stdout.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

/** Download the latest stackql release into the approot. Linux and Windows only. */
export async function install(): Promise<string> {
  const system = process.platform === "win32" ? "windows" : process.platform;
  if (system !== "windows" && system !== "linux") {
    throw new StackQLError(`no automatic download for ${system}, install stackql manually`);
  }
  const arch = system === "linux" && process.arch === "arm64" ? "arm64" : "amd64";
  const url = `${RELEASES}/stackql_${system}_${arch}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new StackQLError(`${url} returned ${response.status}`);
  const file = unzipSync(new Uint8Array(await response.arrayBuffer()))[EXE];
  if (!file) throw new StackQLError(`${EXE} not found in ${url}`);
  mkdirSync(APPROOT, { recursive: true });
  writeFileSync(LOCAL, file, { mode: 0o755 });
  return LOCAL;
}

const auth = (tokenVar: string) =>
  JSON.stringify({ [PROVIDER]: { type: "bearer", credentialsenvvar: tokenVar } });

/** The StackQL MCP server the agent gets for ad hoc queries. Read token only. */
export const mcpServer = () => ({
  type: "stdio" as const,
  command: binary(),
  args: ["mcp", "--approot", APPROOT, "--auth", auth(READ_TOKEN_VAR), "--mcp.server.type=stdio"],
});

/** Run one statement with the in memory backend and return what it printed. stackql exits 0 on failure. */
export async function run(sql: string, tokenVar = READ_TOKEN_VAR): Promise<Output> {
  // "--" ends flag parsing, so a statement may start with a SQL comment
  const args = ["exec", "--approot", APPROOT, "--auth", auth(tokenVar), "--output", "json", "--", sql];
  try {
    const { stdout, stderr } = await io.spawn(binary(), args, { maxBuffer: 2 ** 28 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new StackQLError(
      missing ? "stackql binary not found, run `npm run bootstrap`" : String(e),
    );
  }
}

/**
 * Rows from a statement's output. An error is stderr output with nothing on stdout, because stackql
 * exits 0 either way (stackql/stackql#801, tracked here as stackql/code-estate-warden#1).
 */
export function rows({ stdout, stderr }: Output): Row[] {
  if (!stdout && stderr) throw new StackQLError(stderr);
  // an empty result set is printed as null
  return stdout ? (JSON.parse(stdout) ?? []) : [];
}

export const query = async (sql: string, tokenVar?: string): Promise<Row[]> =>
  rows(await run(sql, tokenVar));

export async function providerVersion(): Promise<string> {
  const row = (await query("SHOW PROVIDERS")).find((r) => r.name === PROVIDER);
  if (!row) throw new StackQLError(`${PROVIDER} provider not installed, run \`npm run bootstrap\``);
  return String(row.version);
}

/** REGISTRY PULL reports success on stderr, so the result is confirmed with a read. */
export async function pullProvider(): Promise<string> {
  await run(`REGISTRY PULL ${PROVIDER}`);
  return providerVersion();
}
