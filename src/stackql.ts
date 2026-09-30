// Thin wrapper around the stackql binary. The only module that spawns it.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

export const PROVIDER = "github";
export const READ_TOKEN_VAR = "REPO_WARDEN_READ_TOKEN";
export const WRITE_TOKEN_VAR = "REPO_WARDEN_WRITE_TOKEN";

const APPROOT = ".stackql";
const EXE = process.platform === "win32" ? "stackql.exe" : "stackql";
const LOCAL = join(APPROOT, EXE);
const RELEASES = "https://releases.stackql.io/stackql/latest";

export type Row = Record<string, unknown>;

export interface Options {
  /** SQLite file for the SQL backend. Without it the backend is in memory and nothing persists. */
  db?: string;
  tokenVar?: string;
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

/** Run one statement and return what it printed. stackql exits 0 on failure. */
export async function run(sql: string, { db, tokenVar = READ_TOKEN_VAR }: Options = {}) {
  const auth = JSON.stringify({ [PROVIDER]: { type: "bearer", credentialsenvvar: tokenVar } });
  const args = ["exec", "--approot", APPROOT, "--auth", auth, "--output", "json"];
  if (db) args.push("--sqlBackend", JSON.stringify({ dsn: `file:${db}` }));
  // "--" ends flag parsing, so a statement may start with a SQL comment
  try {
    const { stdout, stderr } = await io.spawn(binary(), [...args, "--", sql], { maxBuffer: 2 ** 28 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new StackQLError(
      missing ? "stackql binary not found, run `npm run bootstrap`" : String(e),
    );
  }
}

/** Run the statement in a .sql file after filling `{{name}}` placeholders. */
export async function runFile(path: string, vars: Record<string, string>, options?: Options) {
  const sql = (await readFile(path, "utf8")).replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new StackQLError(`${path}: no value for {{${name}}}`);
    return value;
  });
  return run(sql, options);
}

/** Run one statement and return its rows. An error is stderr output with nothing on stdout. */
export async function query(sql: string, options?: Options): Promise<Row[]> {
  const { stdout, stderr } = await run(sql, options);
  if (!stdout && stderr) throw new StackQLError(stderr);
  // an empty result set is printed as null
  return stdout ? (JSON.parse(stdout) ?? []) : [];
}

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
