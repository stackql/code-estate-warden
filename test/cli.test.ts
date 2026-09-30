import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: root, encoding: "utf8" });

test("help lists every command", () => {
  const { status, stdout } = cli("--help");
  assert.equal(status, 0);
  for (const command of ["bootstrap", "snapshot", "evaluate", "plan", "apply", "run"]) {
    assert.ok(stdout.includes(command), command);
  }
});

test("a missing config is a clean error", () => {
  const { status, stderr } = cli("--config", "does-not-exist.toml", "snapshot");
  assert.equal(status, 1);
  assert.match(stderr, /does-not-exist\.toml/);
  assert.doesNotMatch(stderr, /\n\s+at /);
});
