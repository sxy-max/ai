// 兼容层：旧的 lib/message/transform 入口保留导出，实现统一收敛到 Artifact Service 的 lib/artifacts/transform。
// 保留原因：tests/transform.test.ts 从本路径导入 transformHtmlToArtifact / transformAllHtml / findHtmlBlock。
export { findHtmlBlock, shouldFileHtml, transformHtmlToArtifact, transformAllHtml } from "../artifacts/transform";
export type { HtmlArtifact, TransformResult } from "../artifacts/transform";
