import assert from "node:assert/strict";
import { test } from "node:test";
import { applyJobEvent, artifactDisplayKind, fmtSize, INITIAL_JOB, jobBadgeLabel, jobProgress, jobTone, statusStep } from "../../lib/job/ui";

test("1. 事件收敛：status/tool/progress/result/error/done → JobState", () => {
  let job = INITIAL_JOB;
  job = applyJobEvent(job, { type: "status", status: "creating_workspace", message: "创建任务说明" });
  assert.equal(job.status, "creating_workspace");
  job = applyJobEvent(job, { type: "tool", name: "Edit", label: "修改文件" });
  assert.equal(job.tool, "Edit");
  assert.equal(job.toolLabel, "修改文件");
  job = applyJobEvent(job, { type: "progress", detail: "正在改标题" });
  assert.equal(job.progress, "正在改标题");
  job = applyJobEvent(job, { type: "result", summary: "改完了" });
  assert.equal(job.result, "改完了");
  job = applyJobEvent(job, { type: "done", exitCode: 0 });
  assert.equal(job.exitCode, 0);
});

test("2. 非 failed 状态清除 error；failed 保留", () => {
  let job = applyJobEvent(INITIAL_JOB, { type: "error", code: "sandbox_error", message: "沙箱挂了" });
  assert.equal(job.status, "failed");
  assert.equal(job.error, "沙箱挂了");
  job = applyJobEvent(job, { type: "status", status: "done", message: "已完成" });
  assert.equal(job.error, undefined);
  job = applyJobEvent(job, { type: "error", code: "x", message: "又挂了" });
  job = applyJobEvent(job, { type: "status", status: "failed", message: "处理失败" });
  assert.equal(job.error, "又挂了");
});

test("3. progress 累积且有上限", () => {
  let job = INITIAL_JOB;
  for (let i = 0; i < 1000; i++) job = applyJobEvent(job, { type: "progress", detail: "x" });
  assert.ok((job.progress || "").length <= 4000 + 1, "超过上限应截断");
});

test("4. tone / step / progress 映射", () => {
  assert.equal(jobTone("queued"), "idle");
  assert.equal(jobTone("editing"), "active");
  assert.equal(jobTone("done"), "success");
  assert.equal(jobTone("failed"), "error");
  assert.equal(statusStep("queued"), 0);
  assert.equal(jobProgress("done"), 100);
  assert.equal(jobProgress("failed"), 100);
  assert.ok(jobProgress("reading_files") > 0 && jobProgress("reading_files") < 100);
});

test("5. 徽标文案：失败/成功/状态（工具名由 chip 单独展示）", () => {
  assert.equal(jobBadgeLabel({ status: "failed", error: "x" }), "处理失败");
  assert.equal(jobBadgeLabel({ status: "done", exitCode: 0 }), "已完成");
  assert.equal(jobBadgeLabel({ status: "done", exitCode: 1 }), "未完全完成，已保留结果");
  assert.equal(jobBadgeLabel({ status: "editing", toolLabel: "修改文件" }), "修改文件");
  assert.equal(jobBadgeLabel({ status: "generating_artifact" }), "生成产物");
  assert.equal(jobBadgeLabel({ status: "queued" }), "任务已排队");
});

test("6. fmtSize", () => {
  assert.equal(fmtSize(500), "500 B");
  assert.equal(fmtSize(2048), "2.0 KB");
  assert.equal(fmtSize(1048576 * 3), "3.0 MB");
});

test("7. artifactDisplayKind 路由", () => {
  assert.equal(artifactDisplayKind("a.html", "text/html"), "html");
  assert.equal(artifactDisplayKind("a.png", "image/png"), "image");
  assert.equal(artifactDisplayKind("a.PPTX", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), "file");
  assert.equal(artifactDisplayKind("a.csv", "text/csv"), "file");
});
