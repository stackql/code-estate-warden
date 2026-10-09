import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { alerts, http } from "../src/dependabot.ts";
import { READ_TOKEN_VAR } from "../src/stackql.ts";

const token = process.env[READ_TOKEN_VAR];
afterEach(() => {
  mock.restoreAll();
  if (token === undefined) delete process.env[READ_TOKEN_VAR];
  else process.env[READ_TOKEN_VAR] = token;
});

test("alerts uses only the read token and the one approved GET endpoint", async () => {
  process.env[READ_TOKEN_VAR] = "read";
  mock.method(http, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.github.com/repos/acme/one/vulnerability-alerts");
    assert.equal(options.method, "GET");
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer read");
    return new Response(null, { status: 204 });
  });
  assert.deepEqual(await alerts("acme", "one"), { enabled: true, http_status: 204, reason: null });
});

test("404 is a failure only with confirmed repository admin access; 403 remains unknown", async () => {
  process.env[READ_TOKEN_VAR] = "read";
  mock.method(http, "fetch", async () => new Response(null, { status: 404 }));
  assert.equal((await alerts("acme", "one", true)).enabled, false);
  assert.equal((await alerts("acme", "one", false)).enabled, null);
  mock.method(http, "fetch", async () => new Response(null, { status: 403 }));
  assert.equal((await alerts("acme", "one", true)).enabled, null);
});

test("rate limits back off, retry and surface exhausted or server failures", async () => {
  process.env[READ_TOKEN_VAR] = "read";
  let calls = 0;
  mock.method(http, "fetch", async () => new Response(null, calls++ === 0
    ? { status: 429, headers: { "retry-after": "2" } } : { status: 204 }));
  const wait = mock.method(http, "wait", async (ms: number) => { assert.equal(ms, 2000); });
  assert.equal((await alerts("acme", "one")).enabled, true);
  assert.equal(wait.mock.callCount(), 1);
  mock.method(http, "fetch", async () => new Response(null, { status: 500 }));
  await assert.rejects(alerts("acme", "one"), /HTTP 500/);
  mock.method(http, "fetch", async () => new Response(null, { status: 429 }));
  mock.method(http, "wait", async () => {});
  await assert.rejects(alerts("acme", "one"), /HTTP 429/);
});

test("missing credentials fail without making a request", async () => {
  delete process.env[READ_TOKEN_VAR];
  const fetch = mock.method(http, "fetch", async () => { throw new Error("must not fetch"); });
  await assert.rejects(alerts("acme", "one"), /READ_TOKEN/);
  assert.equal(fetch.mock.callCount(), 0);
});
