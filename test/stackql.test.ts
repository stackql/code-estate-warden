import assert from "node:assert/strict";
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
  await stackql.query("SELECT 1", stackql.WRITE_TOKEN_VAR);
  const args = spawn.mock.calls[0]?.arguments[1] ?? [];
  const auth = args[args.indexOf("--auth") + 1] ?? "";
  assert.ok(auth.includes(stackql.WRITE_TOKEN_VAR));
  assert.ok(!auth.includes(stackql.READ_TOKEN_VAR));
});

test("a missing binary points at bootstrap", async () => {
  mock.method(stackql.io, "spawn", async () => {
    throw Object.assign(new Error("spawn stackql ENOENT"), { code: "ENOENT" });
  });
  await assert.rejects(stackql.query("SHOW PROVIDERS"), /npm run bootstrap/);
  assert.equal(await stackql.available(), false);
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
