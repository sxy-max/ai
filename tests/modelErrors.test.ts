import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUpstreamError, friendlyStreamError } from "../lib/modelErrors";

test("classify upstream http errors into structured availability codes", () => {
  const region = classifyUpstreamError(403, JSON.stringify({ error: { message: "region not supported" } }));
  assert.equal(region.code, "MODEL_REGION_UNAVAILABLE");
  assert.match(region.message, /账号或地区不可用/);
  assert.match(region.message, /region not supported/);

  const notFound = classifyUpstreamError(404, "nope");
  assert.equal(notFound.code, "MODEL_NOT_FOUND");
  assert.match(notFound.message, /不存在或暂未开放/);

  const quota = classifyUpstreamError(429, JSON.stringify({ message: "rate limited" }));
  assert.equal(quota.code, "MODEL_QUOTA_EXCEEDED_UPSTREAM");
  assert.match(quota.message, /繁忙或配额受限/);

  const temp = classifyUpstreamError(503, "unavailable");
  assert.equal(temp.code, "MODEL_TEMP_UNAVAILABLE");
  assert.match(temp.message, /暂时不可用/);

  const generic = classifyUpstreamError(422, JSON.stringify({ error: { message: "bad input" } }));
  assert.equal(generic.code, "MODEL_ERROR");
  assert.match(generic.message, /bad input/);

  // 原始 provider 错误文本不应原样透出（无 "Provider request failed" 字样）
  assert.ok(!temp.message.includes("Provider request failed"));
});

test("friendly stream errors translate common provider signatures", () => {
  assert.equal(friendlyStreamError("401 unauthorized"), "该模型在当前账号或地区不可用，请切换其他模型。");
  assert.equal(friendlyStreamError("403 Forbidden: region blocked"), "该模型在当前账号或地区不可用，请切换其他模型。");
  assert.equal(friendlyStreamError("429 Too Many Requests"), "模型服务繁忙或配额受限，请稍后重试。");
  assert.equal(friendlyStreamError("500 Internal Server Error"), "模型服务暂时不可用，请稍后重试。");
  assert.equal(friendlyStreamError("socket hang up timeout"), "模型服务暂时不可用，请稍后重试。");
  assert.equal(friendlyStreamError("?? unknown"), "模型返回了未识别的错误，请重试或切换模型。");
});
