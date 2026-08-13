// HTML >100 → Artifact 单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformHtmlToArtifact, transformAllHtml, findHtmlBlock } from "../lib/message/transform";

function htmlLines(n: number): string {
  const body = Array.from({ length: n }, (_, i) => `  <div>line${i}</div>`).join("\n");
  return `<!DOCTYPE html>\n<html>\n<body>\n${body}\n</body>\n</html>`;
}

test("150 行 HTML 明确要求 → 转为 artifact, raw 从 content 消失", () => {
  const raw = `说明：\n\n\`\`\`html\n${htmlLines(150)}\n\`\`\``;
  const r = transformHtmlToArtifact(raw, true);
  assert.ok(r, "应返回 transform");
  assert.ok(!r!.content.includes("line149"), "raw 尾部不应残留在 content");
  assert.ok(r!.content.includes("line0"), "预览保留前15行");
  assert.ok(r!.content.includes("已转为文件"));
  assert.ok(r!.artifact.content.includes("line149"), "artifact 应含完整 150 行");
});

test("150 行 HTML 未明确要求 → 也转 artifact(超100行)", () => {
  const raw = `\`\`\`html\n${htmlLines(150)}\n\`\`\``;
  const r = transformHtmlToArtifact(raw, false);
  assert.ok(r);
  assert.ok(!r!.content.includes("line149"));
  assert.ok(r!.content.includes("line0"));
});

test("30 行 HTML 未明确要求 → 不转", () => {
  const raw = `\`\`\`html\n${htmlLines(30)}\n\`\`\``;
  const r = transformHtmlToArtifact(raw, false);
  assert.equal(r, null);
});

test("30 行 HTML 明确要求 → 转 artifact", () => {
  const raw = `给我文件：\n\n\`\`\`html\n${htmlLines(30)}\n\`\`\``;
  const r = transformHtmlToArtifact(raw, true);
  assert.ok(r);
  assert.ok(!r!.content.includes("line149"));
  assert.ok(r!.content.includes("line0"));
});

test("transformAllHtml 处理多个 block", () => {
  const raw = `a\n\`\`\`html\n${htmlLines(120)}\n\`\`\`\nb\n\`\`\`html\n${htmlLines(110)}\n\`\`\``;
  const r = transformAllHtml(raw, false);
  assert.equal(r.artifacts.length, 2);
  assert.ok(!r.content.includes("line109"));
  assert.ok(r.content.includes("已转为文件"));
});

test("findHtmlBlock 匹配 ```html(含 \\r)", () => {
  const raw = "```html\r\n<div>x</div>\r\n```";
  const b = findHtmlBlock(raw);
  assert.ok(b);
  assert.ok(b!.code.includes("<div>x</div>"));
});
