import assert from "node:assert/strict";
import { test } from "node:test";
import { executionProfiles, isExecutionProfileChoice, executionProfileModel } from "../lib/execution-profiles";
import { providerHealthRegistry } from "../lib/policy/providerHealth";

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("execution profiles expose Auto, two active profiles, and non-selectable maintenance history", () => {
  withEnv({ E2E_MODE: "1", CLAUDE_RUNTIME_PROFILES_ENABLED: undefined }, () => {
    providerHealthRegistry.record("deepseek-v4-flash", { status: "available", probedAt: Date.now() });
    providerHealthRegistry.record("gpt-5.6-luna", { status: "available", probedAt: Date.now() });
    const profiles = executionProfiles();
    assert.deepEqual(profiles.slice(0, 2).map((profile) => profile.id), ["deepseek-flash", "gpt-luna"]);
    assert.equal(profiles[0].runtimeSelectable, true);
    assert.equal(profiles[1].autoRouting, true);
    assert.ok(profiles.every((profile) => profile.baseUrl === null || profile.baseUrl.endsWith("/v1")));
    assert.ok(profiles.filter((profile) => profile.maintenance).every((profile) => !profile.runtimeSelectable && !profile.autoRouting && profile.displayStatus === "待维修"));
    assert.equal(executionProfileModel("gpt-luna"), "gpt-5.6-luna");
  });
});

test("missing runtime profile credentials are not selectable or routed", () => {
  withEnv({ E2E_MODE: undefined, CLAUDE_RUNTIME_PROFILES_ENABLED: "" }, () => {
    const profiles = executionProfiles().filter((profile) => !profile.maintenance);
    assert.ok(profiles.every((profile) => profile.status === "credential_missing"));
    assert.ok(profiles.every((profile) => !profile.runtimeSelectable && !profile.autoRouting));
    assert.equal(executionProfileModel("deepseek-flash"), undefined);
  });
});

test("profile choice validation keeps Auto separate from model IDs", () => {
  assert.equal(isExecutionProfileChoice("auto"), true);
  assert.equal(isExecutionProfileChoice("deepseek-flash"), true);
  assert.equal(isExecutionProfileChoice("minimax"), false);
});
