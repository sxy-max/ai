/**
 * ArtifactRegistry（V1.4 WP2）：Artifact Type System 2.0。
 * Artifact 不是"一份文件记录"——每类定义 mime/extension/previewStrategy/validator/editor/metadataExtractor/download。
 * 统一入口：ArtifactRegistry.get(type)。
 */

export type ArtifactFamily =
  | "document" | "spreadsheet" | "presentation" | "pdf" | "image"
  | "webpage" | "code_project" | "archive" | "text" | "data";

export type PreviewStrategy = "none" | "slide-thumbnails" | "page-preview" | "html-render" | "table-preview" | "original" | "file-tree";

export type ArtifactTypeDef = {
  family: ArtifactFamily;
  /** 旧 kind 兼容（ArtifactKind）。 */
  kind: string;
  mime: string;
  extensions: string[];
  previewStrategy: PreviewStrategy;
  /** 格式验证器（artifacts/validator 的函数名）。 */
  validator: string;
  /** 编辑器/运行时（generator 或 agent tool）。 */
  editor: string;
  /** 元数据提取（描述）。 */
  metadataExtractor: string;
  download: { inline: boolean; filenamePattern: string };
  /** 是否确定性生成（generator registry）。 */
  hasGenerator: boolean;
};

export const ARTIFACT_REGISTRY: Record<ArtifactFamily, ArtifactTypeDef> = {
  document: {
    family: "document", kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"], previewStrategy: "page-preview", validator: "validateDocx", editor: "docx-generator",
    metadataExtractor: "docx-metadata", download: { inline: false, filenamePattern: "document" }, hasGenerator: true,
  },
  spreadsheet: {
    family: "spreadsheet", kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx", ".xls", ".csv"], previewStrategy: "table-preview", validator: "validateXlsx", editor: "xlsx-generator|spreadsheet-tools",
    metadataExtractor: "xlsx-metadata", download: { inline: false, filenamePattern: "spreadsheet" }, hasGenerator: true,
  },
  presentation: {
    family: "presentation", kind: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"], previewStrategy: "slide-thumbnails", validator: "validatePptx", editor: "pptx-generator",
    metadataExtractor: "pptx-metadata", download: { inline: false, filenamePattern: "presentation" }, hasGenerator: true,
  },
  pdf: {
    family: "pdf", kind: "pdf", mime: "application/pdf",
    extensions: [".pdf"], previewStrategy: "page-preview", validator: "validatePdf", editor: "pdf-pipeline",
    metadataExtractor: "pdf-metadata", download: { inline: false, filenamePattern: "document" }, hasGenerator: false,
  },
  image: {
    family: "image", kind: "image", mime: "image/png",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"], previewStrategy: "original", validator: "validateImage", editor: "vision|image-tools",
    metadataExtractor: "vision-metadata", download: { inline: true, filenamePattern: "image" }, hasGenerator: false,
  },
  webpage: {
    family: "webpage", kind: "html", mime: "text/html",
    extensions: [".html", ".htm"], previewStrategy: "html-render", validator: "validateHtml", editor: "web-generator|agent",
    metadataExtractor: "html-metadata", download: { inline: true, filenamePattern: "page" }, hasGenerator: true,
  },
  code_project: {
    family: "code_project", kind: "code", mime: "application/octet-stream",
    extensions: [], previewStrategy: "file-tree", validator: "validateProject", editor: "agent",
    metadataExtractor: "project-descriptor", download: { inline: false, filenamePattern: "project" }, hasGenerator: false,
  },
  archive: {
    family: "archive", kind: "zip", mime: "application/zip",
    extensions: [".zip"], previewStrategy: "file-tree", validator: "validateZip", editor: "archive-tools",
    metadataExtractor: "zip-manifest", download: { inline: false, filenamePattern: "archive" }, hasGenerator: false,
  },
  text: {
    family: "text", kind: "txt", mime: "text/plain",
    extensions: [".txt", ".md", ".markdown"], previewStrategy: "html-render", validator: "validateText", editor: "document-adapter",
    metadataExtractor: "text-metadata", download: { inline: true, filenamePattern: "text" }, hasGenerator: true,
  },
  data: {
    family: "data", kind: "json", mime: "application/json",
    extensions: [".json"], previewStrategy: "html-render", validator: "validateJson", editor: "data-tools",
    metadataExtractor: "json-metadata", download: { inline: true, filenamePattern: "data" }, hasGenerator: false,
  },
};

export function artifactFamilyForKind(kind: string): ArtifactFamily | null {
  const entry = Object.values(ARTIFACT_REGISTRY).find((t) => t.kind === kind || t.extensions.includes(`.${kind}`));
  return entry?.family || null;
}

export function artifactTypeForFilename(filename: string): ArtifactTypeDef | null {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const entry = Object.values(ARTIFACT_REGISTRY).find((t) => t.extensions.includes(ext));
  if (entry) return entry;
  // markdown 归 text（kind 特例）
  if (ext === ".md" || ext === ".markdown") return ARTIFACT_REGISTRY.text;
  return null;
}

/** 旧 kind → 新 family 映射（向下兼容）。 */
export const KIND_TO_FAMILY: Record<string, ArtifactFamily> = {
  html: "webpage", markdown: "text", csv: "spreadsheet", xlsx: "spreadsheet",
  pptx: "presentation", docx: "document", pdf: "pdf", image: "image",
  zip: "archive", json: "data", txt: "text", code: "code_project",
};

export function familyOfKind(kind: string): ArtifactFamily {
  return KIND_TO_FAMILY[kind] || "data";
}
