import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import JobCard from "../../components/job/JobCard";

const render = (job: any) => renderToString(createElement(JobCard, { job }));

test("1. 进行中：active 徽标 + 工具 chip + 进度条", () => {
  const html = render({ status: "editing", toolLabel: "修改文件", progress: "正在改标题" });
  assert.ok(html.includes("job-card"), "有卡片容器");
  assert.ok(html.includes("job-active"), "active 色调");
  assert.ok(html.includes("job-tool"), "工具 chip");
  assert.ok(html.includes("修改文件"), "阶段徽标");
  assert.ok(html.includes('role="progressbar"'), "进度条");
  assert.ok(html.includes("正在改标题"), "进度文本");
});

test("2. done：success 色调 + 已完成，无进度条", () => {
  const html = render({ status: "done", exitCode: 0 });
  assert.ok(html.includes("job-success"));
  assert.ok(html.includes("已完成"));
  assert.ok(!html.includes("progressbar"), "终态不显示进度条");
});

test("3. failed：error 色调 + 明确错误信息，保留 result", () => {
  const html = render({ status: "failed", error: "沙箱执行超时", result: "已产出部分文件" });
  assert.ok(html.includes("job-error"), "error 色调");
  assert.ok(html.includes("job-error-text"), "错误文本元素");
  assert.ok(html.includes("处理失败"));
  assert.ok(html.includes("沙箱执行超时"), "错误信息展示");
  assert.ok(!html.includes("已产出部分文件"), "error 时 result 不展示");
});

test("4. queued：idle 徽标", () => {
  const html = render({ status: "queued" });
  assert.ok(html.includes("job-idle"));
  assert.ok(html.includes("任务已排队"));
});
