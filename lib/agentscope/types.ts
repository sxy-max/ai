import type { WorkbenchEvent } from "../workbench/types";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AgentScopeNativeEvent = {
  type?: string;
  delta?: string;
  text?: string;
  name?: string;
  tool_call_name?: string;
  tool_call_id?: string;
  state?: "success" | "error" | "interrupted" | "denied" | "running" | string;
  finished_reason?: string;
  error?: unknown;
  [key: string]: unknown;
};

export type DirectoryEntry = {
  name: string;
  is_dir: boolean;
  size_bytes: number | null;
  updated_at?: number | null;
};

export type DirectoryListing = { path: string; entries: DirectoryEntry[] };
export type WorkspaceStatus = { workdir: string; cwd: string; git: unknown | null };

export class AgentScopeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "AgentScopeError";
  }
}

export type { WorkbenchEvent };
