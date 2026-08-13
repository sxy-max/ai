/** Workspace 独立对象模型 —— agent_workspace 任务的沙箱工作目录类型定义。 */

export type WorkspaceLimits = {
  /** 单文件字节上限。 */
  maxFileSize: number;
  /** workspace 内文件总字节上限。 */
  maxTotalSize: number;
  /** 文件数量上限。 */
  maxFiles: number;
  /** 目录深度上限（相对 workspace 根）。 */
  maxDepth: number;
};

export type WorkspaceDirs = {
  root: string;
  input: string;
  output: string;
  artifacts: string;
  task: string;
  internal: string;
};

export type WorkspaceMeta = {
  id: string;
  root: string;
  createdAt: number;
  limits: WorkspaceLimits;
  dirs: WorkspaceDirs;
  taskSpec?: string;
  status: "ready" | "running" | "done" | "failed" | "cleaned";
};

export type CollectedFile = {
  relPath: string;
  absPath: string;
  name: string;
  size: number;
  buffer: Buffer;
};

export type WorkspaceFileInfo = {
  relPath: string;
  absPath: string;
  size: number;
  area: "input" | "output" | "artifacts" | "internal";
};

export type TaskSpec = {
  title?: string;
  prompt: string;
  model?: string;
  visionContext?: string;
  memory?: string[];
  style?: string;
};

export type WorkspaceErrorCode =
  | "path_traversal"
  | "absolute_path"
  | "symlink_escape"
  | "env_reserved"
  | "file_too_large"
  | "total_too_large"
  | "too_many_files"
  | "too_deep"
  | "not_inside_workspace"
  | "zip_bomb"
  | "zip_entry_rejected";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export const DEFAULT_LIMITS: WorkspaceLimits = {
  maxFileSize: 20 * 1024 * 1024,
  maxTotalSize: 100 * 1024 * 1024,
  maxFiles: 200,
  maxDepth: 10,
};
