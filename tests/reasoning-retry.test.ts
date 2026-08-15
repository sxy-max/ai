/** WP14 reasoning 截断重试判定（纯函数）测试。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRetryForLengthTruncation } from "../lib/message/reasoningRetry";

test("stop=length + reasoning-only（无 final 无 artifact）→ 应重试", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: false,
    finalReason: "推理过程…（很长）",
    stopReason: "length",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, true);
});

test("stop=length + 有 final 回答 → 不重试", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "最终回答",
    hasArtifact: false,
    finalReason: "推理…",
    stopReason: "length",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, false);
});

test("stop=length + 有 artifact → 不重试", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: true,
    finalReason: "推理…",
    stopReason: "length",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, false);
});

test("无推理内容 → 不重试（空响应是另一类失败）", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: false,
    finalReason: "",
    stopReason: "length",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, false);
});

test("非截断终止原因（stop/end_turn/工具调用）→ 不重试", () => {
  for (const stopReason of ["stop", "end_turn", "tool_use", "max_tool_uses"]) {
    const decision = shouldRetryForLengthTruncation({
      finalText: "",
      hasArtifact: false,
      finalReason: "推理…",
      stopReason,
      alreadyRetried: false,
    });
    assert.equal(decision.retry, false, `stopReason=${stopReason} 不应重试`);
  }
});

test("已重试过一次 → 不无限重试（无论是否截断）", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: false,
    finalReason: "推理…",
    stopReason: "length",
    alreadyRetried: true,
  });
  assert.equal(decision.retry, false);
});

test("max_tokens 终止原因变体同样触发", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: false,
    finalReason: "推理…",
    stopReason: "max_tokens",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, true);
});

test("stopReason 缺失 → 不重试（无截断证据）", () => {
  const decision = shouldRetryForLengthTruncation({
    finalText: "",
    hasArtifact: false,
    finalReason: "推理…",
    alreadyRetried: false,
  });
  assert.equal(decision.retry, false);
});
