import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import * as stackql from "../src/stackql.ts";

afterEach(() => mock.restoreAll());

/** Replace the process spawn with canned output. The mock records the arguments. */
const fake = (stdout = "", stderr = "") =>
  mock.method(stackql.io, "spawn", async () => ({ stdout, stderr }));

test("query returns rows", async () => {
  fake('[{"login":"octocat"}]');
  assert.deepEqual(await stackql.query("SELECT login FROM github.users.users"), [
    { login: "octocat" },
  ]);
});

test("query returns no rows when stackql prints null", async () => {
  fake("null");
  assert.deepEqual(await stackql.query("SELECT a FROM t"), []);
});

test("query throws on stderr with nothing on stdout", async () => {
  fake("", "cannot resolve service with key = 'nope'");
  await assert.rejects(stackql.query("SELECT x FROM github.nope.nope"), /cannot resolve service/);
});

test("query reads the token from the named variable", async () => {
  const spawn = fake("[]");
  await stackql.query("SELECT 1", { tokenVar: stackql.WRITE_TOKEN_VAR });
  const args = spawn.mock.calls[0]?.arguments[1] ?? [];
  const auth = args[args.indexOf("--auth") + 1] ?? "";
  assert.ok(auth.includes(stackql.WRITE_TOKEN_VAR));
  assert.ok(!auth.includes(stackql.READ_TOKEN_VAR));
});

test("the statement follows a -- separator and the db flag is only set when asked", async () => {
  const spawn = fake("[]");
  await stackql.query("-- comment\nSELECT 1");
  const args = spawn.mock.calls[0]?.arguments[1] ?? [];
  assert.deepEqual(args.slice(-2), ["--", "-- comment\nSELECT 1"]);
  assert.ok(!args.includes("--sqlBackend"));
  await stackql.query("SELECT 1", { db: "runs/x.db" });
  const withDb = spawn.mock.calls[1]?.arguments[1] ?? [];
  assert.equal(withDb[withDb.indexOf("--sqlBackend") + 1], '{"dsn":"file:runs/x.db"}');
});

test("runFile fills placeholders and rejects unknown ones", async () => {
  const spawn = fake("[]");
  const file = join(tmpdir(), `warden-${process.pid}.sql`);
  writeFileSync(file, "SELECT * FROM t WHERE org IN ({{orgs}})");
  await stackql.runFile(file, { orgs: "'a', 'b'" });
  assert.equal(spawn.mock.calls[0]?.arguments[1]?.at(-1), "SELECT * FROM t WHERE org IN ('a', 'b')");
  await assert.rejects(stackql.runFile(file, {}), /no value for \{\{orgs\}\}/);
  rmSync(file);
});

test("a missing binary points at bootstrap", async () => {
  mock.method(stackql.io, "spawn", async () => {
    throw Object.assign(new Error("spawn stackql ENOENT"), { code: "ENOENT" });
  });
  await assert.rejects(stackql.query("SHOW PROVIDERS"), /npm run bootstrap/);
  assert.equal(await stackql.version(), undefined);
});

test("providerVersion", async () => {
  fake('[{"name":"github","version":"v1"}]');
  assert.equal(await stackql.providerVersion(), "v1");
});

test("providerVersion when the provider is not installed", async () => {
  fake('[{"name":"stackql_preview","version":"internal"}]');
  await assert.rejects(stackql.providerVersion(), /not installed/);
});

test("pullProvider accepts success on stderr", async () => {
  mock.method(stackql.io, "spawn", async (_file: string, args: string[]) =>
    args.at(-1)?.startsWith("REGISTRY PULL")
      ? { stdout: "", stderr: "github provider successfully installed" }
      : { stdout: '[{"name":"github","version":"v1"}]', stderr: "" },
  );
  assert.equal(await stackql.pullProvider(), "v1");
});
