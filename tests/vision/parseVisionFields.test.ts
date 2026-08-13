import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVisionFields } from "../../lib/vision";

test("1. 标准字段 → 逐字段解析", () => {
  const out = parseVisionFields([
    "summary：一个登录界面。",
    "visible_text：请输入密码。",
    "layout：上下结构。",
    "ui_elements：顶部输入框。",
    "important_details：按钮蓝色。",
    "uncertainty：无。",
  ].join("\n"));
  assert.equal(out.summary, "一个登录界面。");
  assert.equal(out.visible_text, "请输入密码。");
  assert.equal(out.layout, "上下结构。");
  assert.equal(out.ui_elements, "顶部输入框。");
  assert.equal(out.important_details, "按钮蓝色。");
  assert.equal(out.uncertainty, "无。");
  assert.equal(out.raw, undefined);
});

test("2. 编号/英文冒号/多行续接 → 兼容", () => {
  const out = parseVisionFields([
    "1. summary: 页面概览。",
    "2. visible_text: 第一行文字",
    "    第二行文字。",
  ].join("\n"));
  assert.equal(out.summary, "页面概览。");
  assert.equal(out.visible_text, "第一行文字\n第二行文字。");
});

test("3. 前导非字段行忽略；无分隔的尾部文本并入当前字段", () => {
  const out = parseVisionFields("这是开头的话\nsummary：结果。\n补充说明");
  assert.equal(out.summary, "结果。\n补充说明");
  assert.equal(out.visible_text, undefined);
});

test("4. 一个字段都解析不出 → raw 兜底", () => {
  const out = parseVisionFields("一段没有字段标记的自由文本");
  assert.equal(out.raw, "一段没有字段标记的自由文本");
});

test("5. 空输入 → 空对象", () => {
  assert.deepEqual(parseVisionFields(""), {});
  assert.deepEqual(parseVisionFields("   "), {});
  assert.deepEqual(parseVisionFields(undefined as unknown as string), {});
});
