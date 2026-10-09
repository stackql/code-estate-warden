import assert from "node:assert/strict";
import { test } from "node:test";
import { Config } from "../src/config.ts";
import { CORE_CHECKS, select, selected } from "../src/selection.ts";

const config = Config.parse({ enterprise: "acme", orgs: ["acme", "beta"], exclude_repos: ["acme/skip"], model: "m" });

test("repository URLs and names normalize to an allowlisted, exact target", () => {
  for (const repo of ["acme/one", "https://github.com/acme/one", "https://github.com/acme/one/"]) {
    assert.deepEqual(select(config, { repo, core: true }), { org: "acme", repo: "acme/one", core: true });
  }
  assert.deepEqual(select(config, { org: "ACME", repo: "Acme/One" }), { org: "acme", repo: "acme/One" });
  assert.deepEqual(select(config), {});
  assert.deepEqual(select(config, { org: "beta" }), { org: "beta" });
});

test("invalid and out-of-scope targets are refused before inventory", () => {
  for (const repo of ["one", "acme/one/issues", "https://example.com/acme/one", "http://github.com/acme/one",
    "https://user@github.com/acme/one", "https://github.com/acme/one?q=1", "https://github.com/acme/one#x", "acme/..", ""]) {
    assert.throws(() => select(config, { repo }), Error, repo);
  }
  assert.throws(() => select(config, { repo: "outside/one" }), /allowlist/);
  assert.throws(() => select(config, { repo: "acme/skip" }), /excluded/);
  assert.throws(() => select(config, { repo: "acme/one", org: "beta" }), /same organization/);
});

test("selection never matches prefix repositories, org-wide findings or extra controls", () => {
  const scope = select(config, { repo: "acme/one", core: true });
  const finding = { org: "acme", repo: "one", check_id: "secret_scanning" };
  assert.ok(selected(finding, scope));
  for (const repo of ["one-more", "*", "someone"]) assert.ok(!selected({ ...finding, repo }, scope));
  assert.ok(!selected({ ...finding, check_id: "license_file" }, scope));
  assert.equal(CORE_CHECKS.length, 7, "Dependabot has two checks and SECURITY.md is additional");
});
