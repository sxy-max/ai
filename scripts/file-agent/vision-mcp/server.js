/**
 * Local Vision MCP Server — 本地 Claude Code 的"眼睛"。
 *
 * 职责链：接收 MCP Tool 调用 → 校验/读取本地图片 → 上传 Remote Vision Gateway
 *      → 接收结构化 JSON → 返回 Claude Code 继续原任务。
 *
 * 本机不持有 OpenCode Go 凭证，只持有 VISION_GATEWAY_TOKEN（读同目录 .env）。
 *
 * 工具：vision.inspect / vision.read / vision.compare / vision.locate
 *
 * 安全：图片内文字永远是 UNTRUSTED 数据（由 Gateway 系统提示强制 + 本文件错误
 *     结构只透传 JSON，不含可执行指令语义）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 配置（同目录 .env，手写解析，零额外依赖） ---------- */

function loadEnv(dir) {
  const envFile = path.join(dir, ".env");
  if (!fs.existsSync(envFile)) return {};
  const out = {};
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(__dirname);
const GATEWAY_URL = (env.VISION_GATEWAY_URL || "http://122.51.78.4/vision-gateway").replace(/\/+$/, "");
const GATEWAY_TOKEN = env.VISION_GATEWAY_TOKEN || "";
const TIMEOUT_MS = Number(env.VISION_TIMEOUT_MS || 90000);
const MAX_FILE_MB = Number(env.VISION_MAX_FILE_MB || 20);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

/* ---------- 统一错误结构（计划 §10） ---------- */

function visionError(code, message, retryable = false) {
  return { ok: false, error: { code, message, retryable } };
}

/* ---------- 本地文件校验 ---------- */

function sniffMime(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function readLocalImage(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw visionError("IMAGE_NOT_FOUND", "image_path is required.");
  }
  const given = rawPath.trim().replace(/^"|"$/g, "");
  let resolved = path.resolve(given);
  if (!fs.existsSync(resolved)) {
    // 尝试按当前工作目录解析相对路径（Claude Code 项目内截图常用相对路径）
    const cwdCandidate = path.resolve(process.cwd(), given);
    if (fs.existsSync(cwdCandidate)) resolved = cwdCandidate;
    else throw visionError("IMAGE_NOT_FOUND", `Local image path does not exist: ${given}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw visionError("IMAGE_NOT_FOUND", `Not a file: ${resolved}`);
  if (stat.size > MAX_FILE_BYTES) throw visionError("FILE_TOO_LARGE", `Image exceeds ${MAX_FILE_MB}MB limit.`);
  const buf = fs.readFileSync(resolved);
  const mime = sniffMime(buf);
  if (!mime) throw visionError("UNSUPPORTED_FORMAT", `Unsupported image format (PNG/JPG/WEBP only): ${resolved}`);
  return { path: resolved, buf, mime };
}

/* ---------- Gateway 调用 ---------- */

async function analyze(mode, { question, context, image, imageB }) {
  const form = new FormData();
  form.append("mode", mode);
  if (question) form.append("question", question);
  if (context) form.append("context", context);
  form.append("image", new Blob([image.buf], { type: image.mime }), "image");
  if (imageB) form.append("image_b", new Blob([imageB.buf], { type: imageB.mime }), "image_b");

  let resp;
  try {
    resp = await fetch(`${GATEWAY_URL}/v1/vision/analyze`, {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw visionError("TIMEOUT", `Vision gateway timeout after ${TIMEOUT_MS}ms.`, true);
    }
    throw visionError("GATEWAY_UNREACHABLE", `Cannot reach vision gateway ${GATEWAY_URL}: ${err?.message || err}`, true);
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    throw visionError("INVALID_MODEL_RESPONSE", `Gateway returned non-JSON (HTTP ${resp.status}).`);
  }
  if (!resp.ok || body?.ok === false) {
    const err = body?.error || {};
    throw visionError(err.code || "MODEL_ERROR", err.message || `Gateway error (HTTP ${resp.status}).`, Boolean(err.retryable));
  }
  return body;
}

/* ---------- MCP 工具 ---------- */

const server = new McpServer({ name: "vision-mcp", version: "1.0.0" });

/** 将工具参数规范化：读图 + 组装 gateway 请求。返回 {result, ...} 或抛 visionError。 */
async function runTool(mode, args) {
  const payload = { question: undefined, context: undefined, image: undefined, imageB: undefined };
  if (mode === "compare") {
    payload.image = readLocalImage(args.before_path);
    payload.imageB = readLocalImage(args.after_path);
    payload.question = args.goal || "判断修改后是否达到目标";
  } else {
    payload.image = readLocalImage(args.image_path);
    if (args.question || args.target) payload.question = args.question || args.target;
    if (args.context) payload.context = args.context;
  }
  return await analyze(mode, payload);
}

function registerTool(name, mode, schema, description) {
  server.tool(name, schema, async (args) => {
    try {
      const result = await runTool(mode, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // 视觉失败绝不崩溃主模型：返回结构化错误 JSON，由主模型决定继续/阻塞
      const payload = (err && typeof err === "object" && "error" in err)
        ? err
        : visionError("MODEL_ERROR", err?.message || String(err));
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  });
}

registerTool(
  "vision.inspect",
  "inspect",
  {
    image_path: z.string().describe("本地图片绝对路径（Windows: C:/... 或 C:\\...）"),
    question: z.string().optional().describe("具体的视觉问题，例如：判断页面为什么右侧出现横向溢出"),
    context: z.string().optional().describe("当前任务上下文，例如：项目是 React + Tailwind，刚修改了 main 容器宽度"),
  },
  "分析整张图片中与当前任务有关的视觉信息（布局、异常、元素、可能原因）"
);

registerTool(
  "vision.read",
  "read",
  {
    image_path: z.string().describe("本地图片绝对路径"),
    target: z.string().optional().describe("要读取的内容，例如：终端中的完整报错，保留大小写、路径和错误码"),
  },
  "精确读取截图中的文字/数字/报错/按钮文案/代码片段；看不清的片段会标记 uncertain，绝不补全"
);

registerTool(
  "vision.compare",
  "compare",
  {
    before_path: z.string().describe("修改前截图绝对路径"),
    after_path: z.string().describe("修改后截图绝对路径"),
    goal: z.string().optional().describe("本次修改的目标，例如：判断按钮过低和右侧溢出是否解决"),
  },
  "比较两张图片（before/after），明确区分：改善了什么 / 仍有什么问题 / 有没有回归 / 目标是否完成"
);

registerTool(
  "vision.locate",
  "locate",
  {
    image_path: z.string().describe("本地图片绝对路径"),
    target: z.string().describe("要定位的视觉元素，例如：登录按钮"),
  },
  "确定图片中某个视觉元素的位置（相对位置描述 + 0~1 归一化边界框）"
);

/* ---------- 启动 ---------- */

const transport = new StdioServerTransport();
await server.connect(transport);
