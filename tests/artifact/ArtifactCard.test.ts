import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import ArtifactCard from "../../components/artifact/ArtifactCard";

const base = { id: "a1", name: "", mime: "", size: 2048, downloadUrl: "/api/artifacts/a1" };
const render = (a: any) => renderToString(createElement(ArtifactCard, { a }));

test("1. 下载卡：pptx/csv/md → 名称 + 类型 + 大小 + 下载按钮", () => {
  const html = render({ ...base, name: "report.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  assert.ok(html.includes("artifact-card"));
  assert.ok(html.includes("report.pptx"));
  assert.ok(html.includes("2.0 KB"));
  assert.ok(html.includes("下载"));
});

test("2. pending：显示生成中", () => {
  const html = render({ ...base, name: "out.md", mime: "text/markdown", status: "pending" });
  assert.ok(html.includes("artifact-pending"));
  assert.ok(html.includes("生成中…"));
  assert.ok(!html.includes("下载"));
});

test("3. image：内联缩略图", () => {
  const html = render({ ...base, name: "shot.png", mime: "image/png" });
  assert.ok(html.includes("artifact-thumb"));
  assert.ok(html.includes('src="/api/artifacts/a1"'));
});

test("4. html：内联预览（首帧为加载态）", () => {
  const html = render({ ...base, name: "page.html", mime: "text/html" });
  assert.ok(html.includes("artifact-html"));
  assert.ok(html.includes("加载预览中…"));
});
