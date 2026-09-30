import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Config, loadConfig } from "../src/config.ts";

const minimal = { enterprise: "acme", orgs: ["acme"], model: "some-model" };

test("shipped config is valid", () => {
  const config = loadConfig(join(import.meta.dirname, "..", "repo-warden.toml"));
  assert.ok(config.orgs.length > 0);
  assert.equal(config.issue_label, "repo-warden");
});

test("defaults", () => {
  const config = Config.parse(minimal);
  assert.deepEqual(config.exclude_repos, []);
  assert.deepEqual(config.severity, {});
});

const invalid = {
  "an empty org allowlist": { orgs: [] },
  "an exclusion without an org": { exclude_repos: ["no-org-prefix"] },
  "an unknown severity": { severity: { secret_scanning: "critical" } },
  "an unknown key": { unknown_key: 1 },
};

for (const [name, override] of Object.entries(invalid)) {
  test(`rejects ${name}`, () => {
    assert.equal(Config.safeParse({ ...minimal, ...override }).success, false);
  });
}
