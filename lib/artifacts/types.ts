/** Artifact 独立对象模型 —— 聊天消息只保存元数据，完整内容由 Artifact Service 存储。 */

export type ArtifactKind =
  | "html"
  | "markdown"
  | "csv"
  | "json"
  | "txt"
  | "pptx"
  | "xlsx"
  | "docx"
  | "pdf"
  | "image"
  | "zip"
  | "code"
  | "unknown";

export type ArtifactStatus = "ready" | "expired" | "failed";

export type ArtifactSource = "chat" | "artifact_task" | "file_agent" | "manual_upload" | "upload" | "agent" | "preview";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  size: number;
  status: ArtifactStatus;
  source: ArtifactSource;
  /** 关联任务（file_agent / artifact_task）的 jobId。 */
  jobId?: string;
  /** 关联聊天消息（chat 来源）的 messageId。 */
  messageId?: string;
  createdAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type ArtifactContent = {
  artifactId: string;
  content: string | Buffer;
  storage: "memory" | "local" | "workspace";
};

export type CreateArtifactInput = {
  filename: string;
  content: string | Buffer;
  kind?: ArtifactKind;
  mimeType?: string;
  source?: ArtifactSource;
  jobId?: string;
  messageId?: string;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
};

/** 下发给前端的 Artifact 元数据（不含内容）。 */
export type ClientArtifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  mime: string;
  size: number;
  status: ArtifactStatus;
  downloadUrl: string;
};
