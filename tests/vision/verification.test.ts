/** VisionVerifier 测试（V1.2 WP12）：结构化视觉对比。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVisionContexts, feedbackInstruction } from "../../lib/vision/verification";

const REFERENCE: Parameters<typeof compareVisionContexts>[0] = {
  summary: "深色科技风页面，居中卡片布局",
  visible_text: "Cloud AI Work System / Go AI 云工作台 / 开始使用 / 文件理解 / Agent 执行 / 产物交付",
  layout: "单卡片居中，背景深色，卡片内有徽章、标题、按钮、三列功能瓷片",
  colors: "深蓝背景 #0b0f1a，卡片 #1b2340，蓝色按钮 #3b82f6",
  ui_elements: "1 个徽章、1 个标题、1 个按钮、3 个功能卡片",
  objects: "卡片、按钮、功能瓷片",
  relationships: "标题在徽章下方，按钮在描述下方，功能卡片并列",
};

test("一致实现 → pass（score 高）", () => {
  const result = {
    summary: "深色卡片页面",
    visible_text: "Cloud AI Work System / Go AI 云工作台 / 开始使用 / 文件理解 / Agent 执行 / 产物交付",
    layout: "深色背景，居中卡片，徽章+标题+按钮+三个功能瓷片",
    colors: "深蓝背景 #0b0f1a，蓝色按钮 #3b82f6，深色卡片",
    ui_elements: "1 个徽章、1 个标题、1 个按钮、3 个功能卡片",
  };
  const verdict = compareVisionContexts(REFERENCE, result);
  assert.equal(verdict.pass, true, `score ${verdict.score} 应通过`);
  assert.equal(verdict.feedback.length, 0);
});

test("偏离实现（文字/配色/元素数量全变）→ fail + 差距反馈", () => {
  const result = {
    summary: "浅色欢迎页",
    visible_text: "欢迎使用 / 点击进入",
    layout: "白底居中",
    colors: "白色背景，绿色按钮",
    ui_elements: "1 个按钮",
  };
  const verdict = compareVisionContexts(REFERENCE, result);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.missing.includes("visible_text"), "文字差异应被标记");
  assert.ok(verdict.missing.includes("colors"), "配色差异应被标记");
  assert.ok(verdict.missing.includes("ui_elements"), "元素数量差异应被标记");
  assert.ok(verdict.feedback.length >= 3);
  assert.ok(verdict.score < 0.55, `score ${verdict.score} 应低于阈值`);
});

test("反馈指令可注入 repair（非空且可读）", () => {
  const verdict = compareVisionContexts(REFERENCE, {
    summary: "浅色页面",
    visible_text: "欢迎",
    layout: "白底",
    colors: "白色",
    ui_elements: "1 个按钮",
  });
  const instruction = feedbackInstruction(verdict);
  assert.match(instruction, /视觉验证未通过/);
  assert.match(instruction, /配色|文字|元素/);
});

test("pass 时反馈指令为空（不干扰正常任务）", () => {
  const verdict = compareVisionContexts(REFERENCE, {
    visible_text: "Cloud AI Work System / Go AI 云工作台 / 开始使用 / 文件理解 / Agent 执行 / 产物交付",
    layout: "深色背景居中卡片",
    colors: "深蓝背景，蓝色按钮",
    ui_elements: "3 个功能卡片、1 个按钮",
  });
  assert.equal(verdict.pass, true);
  assert.equal(feedbackInstruction(verdict), "");
});
