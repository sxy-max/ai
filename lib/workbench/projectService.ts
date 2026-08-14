import { createAgentScopeClient } from "../agentscope/client";
import type { Project } from "./projectStore";
import { projectStore, type ProjectStore } from "./projectStore";

export const INTERNAL_USER_ID = "owner";
export const WORKSPACE_AGENT_PROMPT = `You are the autonomous execution agent for a persistent cloud project workspace, not a chat assistant.
Inspect the project files and use the available workspace tools to complete each task. You may read, write, edit, search, run shell commands, install dependencies, and run tests inside the isolated workspace.
For every file creation or modification task, perform the work and verify it. Save every user deliverable under /workspace/outputs. A text-only claim is never a deliverable. When tools are available, never answer that you cannot create or modify a file.`;

export type ProjectRuntimeClient = ReturnType<typeof createAgentScopeClient>;

export function runtimeClient() {
  const baseUrl = process.env.AGENTSCOPE_URL?.trim();
  if (!baseUrl) throw new Error("AGENTSCOPE_URL is required");
  return createAgentScopeClient({ baseUrl, userId: INTERNAL_USER_ID });
}

function providerConfig() {
  const provider = (process.env.AGENTSCOPE_PROVIDER || "deepseek").toLowerCase();
  if (provider !== "deepseek") throw new Error("Only deepseek is supported in the first workbench slice");
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const model = process.env.AGENTSCOPE_MODEL?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
  if (!model) throw new Error("AGENTSCOPE_MODEL is required");
  return {
    credential: {
      type: "deepseek_credential",
      name: "Go AI DeepSeek",
      api_key: apiKey,
      base_url: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"
    },
    credentialType: "deepseek_credential",
    model
  };
}

export async function provisionProject(name: string, ownerId?: string, dependencies?: { client?: ProjectRuntimeClient; store?: ProjectStore }): Promise<Project> {
  const client = dependencies?.client || runtimeClient();
  const store = dependencies?.store || projectStore;
  const config = providerConfig();
  const credential = await client.createCredential(config.credential);
  const agent = await client.createAgent({
    name: "Go AI Project Executor",
    system_prompt: WORKSPACE_AGENT_PROMPT,
    context_config: {},
    react_config: {},
    invite_config: { invitable: false, invite_description: null }
  });
  const session = await client.createSession({
    agent_id: agent.agent_id,
    name: name.trim(),
    chat_model_config: {
      type: config.credentialType,
      credential_id: credential.credential_id,
      model: config.model,
      parameters: {}
    }
  });
  await client.setPermissionBypass(agent.agent_id, session.session_id);
  return store.create({ name, agentId: agent.agent_id, sessionId: session.session_id, ownerId });
}

export function taskInstruction(task: string) {
  const prompt = task.trim();
  if (!prompt) throw new Error("TASK_REQUIRED");
  return `${prompt}\n\nExecution contract:\n- Inspect and use files under /workspace/input when present.\n- Complete the requested work using workspace tools; do not merely describe it.\n- Run appropriate validation or tests.\n- Put all user-downloadable deliverables under /workspace/outputs.\n- Report the exact output paths, but remember that text alone does not count as completion.`;
}

