/**
 * 模型可用性错误分类与友好文案。
 * 不把 provider 原始 403/503 直接交给用户：区分
 * available / temporarily unavailable / region unavailable / quota exhausted。
 */

export type ModelErrorCode =
  | "MODEL_REGION_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "MODEL_QUOTA_EXCEEDED_UPSTREAM"
  | "MODEL_TEMP_UNAVAILABLE"
  | "MODEL_ERROR";

export type ClassifiedError = { code: ModelErrorCode; message: string; status: number };

/**
 * 把上游 HTTP 错误分类为结构化可用性错误。
 */
export function classifyUpstreamError(status: number, raw: string): ClassifiedError {
  let detail = "";
  try {
    const j = JSON.parse(raw);
    detail = String(j?.error?.message || j?.message || j?.detail || "").slice(0, 200);
  } catch {}
  const suffix = detail ? `（${detail}）` : "";
  if (status === 401 || status === 403) {
    return { code: "MODEL_REGION_UNAVAILABLE", status: 403, message: `该模型在当前账号或地区不可用，请切换其他模型。${suffix}` };
  }
  if (status === 404) {
    return { code: "MODEL_NOT_FOUND", status: 404, message: "该模型不存在或暂未开放，请切换其他模型。" };
  }
  if (status === 429) {
    return { code: "MODEL_QUOTA_EXCEEDED_UPSTREAM", status: 429, message: `模型服务繁忙或配额受限，请稍后重试。${suffix}` };
  }
  if (status >= 500) {
    return { code: "MODEL_TEMP_UNAVAILABLE", status: 502, message: `模型服务暂时不可用，请稍后重试。${suffix}` };
  }
  return { code: "MODEL_ERROR", status: status || 502, message: detail ? `模型请求失败：${detail}` : `模型请求失败（${status}）` };
}

/**
 * 流中出现的上游错误 → 友好文案（匹配常见 401/403/429/5xx 特征）。
 */
export function friendlyStreamError(value: string): string {
  const s = String(value || "");
  if (/401|403|unauthorized|forbidden|permission|access.{0,10}denied|region|area not|not allowed in|blocked/i.test(s)) return "该模型在当前账号或地区不可用，请切换其他模型。";
  if (/429|rate\s*limit|quota|too\s*many|overload|throttle|busy/i.test(s)) return "模型服务繁忙或配额受限，请稍后重试。";
  if (/5\d\d|internal\s*server|temporar|unavailable|gateway|timeout|timed out|overload/i.test(s)) return "模型服务暂时不可用，请稍后重试。";
  return "模型返回了未识别的错误，请重试或切换模型。";
}
