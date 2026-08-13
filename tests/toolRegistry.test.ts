import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isFileTaskPrompt, resolveTaskTools, searchTriggerHeuristic, toolRegistry } from "../lib/toolRegistry";

const ctx = (over = {}) => ({ searchMode: "auto" as const, hasUrls: false, hasImages: false, hasFiles: false, ...over });

afterEach(() => {
  toolRegistry.unregister("test-external-tool");
});

test("task tools resolve only what the task needs", () => {
  assert.deepEqual(resolveTaskTools("普通问候", ctx()), []);
  assert.deepEqual(resolveTaskTools("https://example.com 帮我看看", ctx({ hasUrls: true })), ["url_fetch"]);
  assert.deepEqual(resolveTaskTools("帮我改这个 index.html", ctx({ hasFiles: true })), ["file_agent"]);
  assert.deepEqual(resolveTaskTools("这张图里写了什么", ctx({ hasImages: true })), ["vision"]);
  const news = resolveTaskTools("今天的新闻", ctx());
  assert.ok(news.includes("web_search"));
});

test("search triggers only on timeliness/price/news signals", () => {
  assert.equal(searchTriggerHeuristic("今天的天气"), true);
  assert.equal(searchTriggerHeuristic("iPhone 16 价格"), true);
  assert.equal(searchTriggerHeuristic("解释一下什么是归并排序"), false);
  assert.equal(searchTriggerHeuristic(""), false);
});

test("file task detection requires explicit intent or files", () => {
  assert.equal(isFileTaskPrompt("按照截图修改这个网页", true), true);
  assert.equal(isFileTaskPrompt("帮我生成 index.html", false), true);
  assert.equal(isFileTaskPrompt("你好", false), false);
  assert.equal(isFileTaskPrompt("处理一下", true), true);
  assert.equal(isFileTaskPrompt("处理一下", false), false);
});

test("external tools are disabled until explicitly granted", () => {
  toolRegistry.register({ id: "test-external-tool", name: "外部 MCP", capability: "external_mcp", description: "测试", enabled: false, builtin: false });
  // 未授权 → 不进入任何任务结果
  assert.ok(!resolveTaskTools("任意任务", ctx()).includes("test-external-tool"));
  // 显式授权后才会被解析出来
  toolRegistry.register({ id: "test-external-tool", name: "外部 MCP", capability: "external_mcp", description: "测试", enabled: true, builtin: false });
  assert.ok(resolveTaskTools("任意任务", ctx()).includes("test-external-tool"));
});
