// Message Lifecycle 本地单测(不依赖真实模型)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMessage, textOf, reasoningOf, hasArtifact, isUsableForUpstream,
} from "../lib/message/types";
import {
  createAccumulator, accumulate, finalizeStatus, partsFromAccumulator, sanitizeForUpstream,
} from "../lib/message/lifecycle";

// mock 流事件序列
const mockStreams = {
  reasoningFinal: [
    { type: "reasoning", value: "先考虑平衡条件。" },
    { type: "reasoning", value: "再求临界角速度。" },
    { type: "text", value: "最终答案是 ω0 = sqrt(g/R)。" },
  ],
  reasoningOnly: [
    { type: "reasoning", value: "推理了一堆，但没输出正文。" },
  ],
  textOnly: [
    { type: "text", value: "你好！" },
  ],
};

test("reasoning 是独立 part, 不并进 text", () => {
  const acc = createAccumulator();
  for (const ev of mockStreams.reasoningFinal) accumulate(acc, ev as any);
  const m = createMessage("a1", "assistant", partsFromAccumulator(acc), finalizeStatus(acc, false));
  assert.equal(m.status, "completed");
  assert.equal(textOf(m), "最终答案是 ω0 = sqrt(g/R)。");
  assert.ok(reasoningOf(m).includes("平衡条件"));
  assert.ok(!textOf(m).includes("平衡条件"), "reasoning 不得混入 text");
});

test("reasoning-only → incomplete, 不可用于上游", () => {
  const acc = createAccumulator();
  for (const ev of mockStreams.reasoningOnly) accumulate(acc, ev as any);
  const status = finalizeStatus(acc, false);
  assert.equal(status, "incomplete");
  const m = createMessage("a2", "assistant", partsFromAccumulator(acc), status);
  assert.equal(textOf(m).trim(), "");
  assert.ok(reasoningOf(m).length > 0);
  assert.equal(isUsableForUpstream(m), false, "reasoning-only 不能当正文进上游");
});

test("textOnly → complete, 可用于上游", () => {
  const acc = createAccumulator();
  for (const ev of mockStreams.textOnly) accumulate(acc, ev as any);
  const m = createMessage("a3", "assistant", partsFromAccumulator(acc), finalizeStatus(acc, false));
  assert.equal(m.status, "completed");
  assert.equal(isUsableForUpstream(m), true);
});

test("sanitize 过滤空 assistant(三层防御之一)", () => {
  const empty = createMessage("e1", "assistant", [], "incomplete");
  const good = createMessage("g1", "assistant", [{ type: "text", text: "OK" }], "completed");
  const artifact = createMessage("ar1", "assistant", [{ type: "artifact", artifactId: "x", name: "a.html", mime: "text/html", size: 10 }], "completed");
  const user = createMessage("u1", "user", [{ type: "text", text: "你好" }]);
  const cleaned = sanitizeForUpstream([empty, good, artifact, user]);
  assert.deepEqual(cleaned.map((m) => m.id), ["g1", "ar1", "u1"]);
});

test("artifact part 使无 text 的 assistant 仍可用", () => {
  const m = createMessage("a5", "assistant", [{ type: "artifact", artifactId: "y", name: "i.html", mime: "text/html", size: 5 }], "completed");
  assert.equal(hasArtifact(m), true);
  assert.equal(isUsableForUpstream(m), true);
});
