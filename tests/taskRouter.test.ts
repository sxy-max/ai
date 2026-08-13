import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTask, type ClassifyAttachment, type ClassifyInput } from "../lib/taskRouter";

const text = (name = "a.txt"): ClassifyAttachment => ({ kind: "text", mime: "text/plain", name });
const image = (name = "a.png"): ClassifyAttachment => ({ kind: "image", mime: "image/png", name });
const input = (message: string, attachments: ClassifyAttachment[] = []): ClassifyInput => ({ message, attachments });

test("R6: 普通问答 → chat", () => {
  assert.equal(classifyTask(input("你好"))?.type, "chat");
  assert.equal(classifyTask(input("你叫什么名字"))?.type, "chat");
});

test("R6: 解释商业 → chat", () => {
  const intent = classifyTask(input("解释一下什么是商业"));
  assert.equal(intent?.type, "chat");
  assert.equal(intent?.routeTarget, "chat");
});

test("R6: 旋转圆环物理题 → chat", () => {
  assert.equal(classifyTask(input("一个旋转圆环的物理问题，角动量怎么算"))?.type, "chat");
});

test("R1: 给我做两页 PPT → artifact/pptx", () => {
  const intent = classifyTask(input("给我做两页 PPT"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "pptx");
  assert.equal(intent?.needsSandbox, false);
});

test("R1: 生成一个 PPT 文件 → artifact/pptx", () => {
  const intent = classifyTask(input("生成一个 PPT 文件"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "pptx");
});

test("R1: 给我 HTML 文件 → artifact/html", () => {
  const intent = classifyTask(input("给我 HTML 文件"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "html");
});

test("R1: 生成 index.html → artifact/html", () => {
  const intent = classifyTask(input("生成 index.html"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "html");
});

test("R1: 导出 CSV → artifact/csv", () => {
  const intent = classifyTask(input("导出 CSV"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "csv");
});

test("R1: 生成 markdown 文件 → artifact/markdown", () => {
  const intent = classifyTask(input("生成 markdown 文件"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "markdown");
});

test("R1: 不要贴代码，直接给文件 → artifact/unknown", () => {
  const intent = classifyTask(input("不要贴代码，直接给文件"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "unknown");
  assert.equal(intent?.routeTarget, "artifact");
});

test("R2: 上传 HTML + 修改这个 HTML → agent_workspace", () => {
  const intent = classifyTask(input("修改这个 HTML", [text("index.html")]));
  assert.equal(intent?.type, "agent_workspace");
  assert.equal(intent?.needsSandbox, true);
  assert.equal(intent?.routeTarget, "file_agent");
});

test("R2: 上传 MD + 整理这个 Markdown → agent_workspace", () => {
  const intent = classifyTask(input("整理这个 Markdown", [text("a.md")]));
  assert.equal(intent?.type, "agent_workspace");
});

test("R2: 上传 ZIP + 改这个项目 → agent_workspace", () => {
  const intent = classifyTask(input("把这个 ZIP 项目改一下", [text("p.zip")]));
  assert.equal(intent?.type, "agent_workspace");
});

test("R2: 上传 CSV + 清洗表格 → agent_workspace", () => {
  const intent = classifyTask(input("把这个表格清洗一下", [text("d.csv")]));
  assert.equal(intent?.type, "agent_workspace");
});

test("R4: 图片 + 你看到了什么 → chat", () => {
  const intent = classifyTask(input("你看到了什么", [image()]));
  assert.equal(intent?.type, "chat");
  assert.equal(intent?.routeTarget, "chat");
});

test("R4: 图片 + 这张图什么意思 → chat", () => {
  const intent = classifyTask(input("这张图什么意思", [image()]));
  assert.equal(intent?.type, "chat");
});

test("R3: 图片 + 按截图修改网页 → agent_workspace", () => {
  const intent = classifyTask(input("按这张截图修改网页", [image("shot.png")]));
  assert.equal(intent?.type, "agent_workspace");
  assert.equal(intent?.needsSandbox, true);
});

test("R3: 图片 + 根据这张图做 PPT → agent_workspace", () => {
  const intent = classifyTask(input("根据这张图做 PPT", [image("design.png")]));
  assert.equal(intent?.type, "agent_workspace");
});

test("R5: 纯文本搭一个小网页项目 → agent_workspace", () => {
  const intent = classifyTask(input("搭一个小网页项目"));
  assert.equal(intent?.type, "agent_workspace");
  assert.equal(intent?.needsSandbox, true);
});

test("R0: 空输入且无附件 → reject（null）", () => {
  assert.equal(classifyTask(input("")), null);
});

test("辅助：上传文件但只是问内容 → chat（不误入 agent）", () => {
  const intent = classifyTask(input("这个文件讲了什么", [text("readme.md")]));
  assert.equal(intent?.type, "chat");
});

test("辅助：图片引用 + 复刻 → agent_workspace", () => {
  const intent = classifyTask(input("根据图片复刻 HTML", [image()]));
  assert.equal(intent?.type, "agent_workspace");
});

test("辅助：纯文本生成简单 html → artifact", () => {
  const intent = classifyTask(input("生成一个简单的 html"));
  assert.equal(intent?.type, "artifact");
  assert.equal(intent?.artifactKind, "html");
});
