/** WP2 测试：Agent Completion Contract（系统级完成判定）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesGlob,
  artifactMatchesExpectation,
  validateTaskCompletion,
  type TaskArtifactLike,
  type TaskCompletionContract
} from "../../lib/tasks/completion";

const A = (id: string, name: string, type: string, size = 100): TaskArtifactLike => ({ id, name, type, size, status: "ready" });

test("matchesGlob：*.pptx / index.html 精确匹配", () => {
  assert.equal(matchesGlob("*.pptx", "演示文稿.pptx"), true);
  assert.equal(matchesGlob("*.pptx", "演示文稿.html"), false);
  assert.equal(matchesGlob("index.html", "index.html"), true);
  assert.equal(matchesGlob("index.html", "page.html"), false);
});

test("artifactMatchesExpectation：kind + filenamePattern + 非空", () => {
  const pptx = A("a1", "报告.pptx", "pptx", 2048);
  assert.equal(artifactMatchesExpectation(pptx, { kind: "pptx" }), true);
  assert.equal(artifactMatchesExpectation(pptx, { filenamePattern: "*.pptx" }), true);
  assert.equal(artifactMatchesExpectation(pptx, { kind: "html" }), false);
  assert.equal(artifactMatchesExpectation(A("a2", "空.txt", "txt", 0), { kind: "txt" }), false, "空文件不合格");
});

test("validateTaskCompletion：契约满足 → completed", async () => {
  const contract: TaskCompletionContract = {
    expectations: [{ kind: "pptx", minCount: 1 }],
    minArtifacts: 1,
    validationPolicy: "strict"
  };
  const verdict = await validateTaskCompletion("t1", [A("a1", "报告.pptx", "pptx", 2048)], contract);
  assert.equal(verdict.status, "completed");
});

test("validateTaskCompletion：缺预期产物 → retryable_failed（可修复）", async () => {
  const contract: TaskCompletionContract = {
    expectations: [{ kind: "pptx", minCount: 1 }],
    minArtifacts: 1,
    validationPolicy: "strict"
  };
  const verdict = await validateTaskCompletion("t2", [A("a1", "说明.md", "markdown")], contract);
  assert.equal(verdict.status, "retryable_failed");
  assert.equal(verdict.missing.length, 1);
  assert.match(verdict.reason, /pptx/);
});

test("validateTaskCompletion：格式验证失败 → retryable_failed", async () => {
  const contract: TaskCompletionContract = {
    expectations: [{ kind: "html", minCount: 1, validate: "format" }],
    minArtifacts: 1,
    validationPolicy: "strict"
  };
  const verdict = await validateTaskCompletion(
    "t3",
    [A("a1", "page.html", "html", 500)],
    contract,
    async () => ({ artifactId: "a1", filename: "page.html", kind: "html", ok: false, checks: { structure: { ok: false, detail: "缺 <html> 标签" } }, error: "HTML 结构不合法" })
  );
  assert.equal(verdict.status, "retryable_failed");
  assert.match(verdict.reason, /格式验证失败/);
});

test("validateTaskCompletion：lenient 策略任一满足即可", async () => {
  const contract: TaskCompletionContract = {
    expectations: [{ kind: "pptx" }, { kind: "html" }],
    minArtifacts: 1,
    validationPolicy: "lenient"
  };
  const verdict = await validateTaskCompletion("t4", [A("a1", "page.html", "html")], contract);
  assert.equal(verdict.status, "completed");
});

test("validateTaskCompletion：产物总数不足 → retryable_failed", async () => {
  const contract: TaskCompletionContract = { expectations: [], minArtifacts: 2, validationPolicy: "strict" };
  const verdict = await validateTaskCompletion("t5", [A("a1", "one.txt", "txt")], contract);
  assert.equal(verdict.status, "retryable_failed");
  assert.match(verdict.reason, /产物总数不足/);
});
