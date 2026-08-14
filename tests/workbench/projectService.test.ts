import assert from "node:assert/strict";
import test from "node:test";
import { provisionProject, WORKSPACE_AGENT_PROMPT } from "../../lib/workbench/projectService";

test("project agent is execution-first and receives sandbox bypass", async () => {
  process.env.DEEPSEEK_API_KEY = "test-secret-never-persist";
  process.env.AGENTSCOPE_MODEL = "deepseek-test";
  const calls: Array<[string, unknown]> = [];
  const client = {
    createCredential: async (body: unknown) => { calls.push(["credential", body]); return { credential_id: "c1" }; },
    createAgent: async (body: unknown) => { calls.push(["agent", body]); return { agent_id: "a1" }; },
    createSession: async (body: unknown) => { calls.push(["session", body]); return { session_id: "s1" }; },
    setPermissionBypass: async (agent: string, session: string) => { calls.push(["bypass", { agent, session }]); return {}; }
  } as never;
  const store = { create: async (input: unknown) => input } as never;
  const project = await provisionProject("Demo", undefined, { client, store });
  assert.equal(project.name, "Demo");
  assert.equal(project.agentId, "a1");
  assert.equal(project.sessionId, "s1");
  assert.match(WORKSPACE_AGENT_PROMPT, /not a chat assistant/i);
  assert.match(WORKSPACE_AGENT_PROMPT, /\/workspace\/outputs/);
  assert.equal(calls.some(([name]) => name === "bypass"), true);
  assert.equal(JSON.stringify(project).includes("test-secret"), false);
});

