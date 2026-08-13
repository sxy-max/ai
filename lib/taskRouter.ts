/**
 * Task Router —— 统一任务分类层（Phase A）。
 *
 * 把用户请求分类为 chat / artifact / agent_workspace，作为后续
 * Artifact Service、Workspace Manager、Agent Runner 的共同入口。
 * 本模块是纯函数（无 I/O、可在服务端与客户端复用），只做判定，
 * 不做执行。旧 lib/toolRegistry 的 isFileTaskPrompt 保留为辅助信号
 * 与兼容 fallback，不再作为前端主判定。
 */

export type TaskType = "chat" | "artifact" | "agent_workspace";

export type ArtifactKind = "pptx" | "html" | "csv" | "markdown" | "json" | "txt" | "zip" | "unknown";

export type TaskConfidence = "high" | "medium" | "low";

export type RouteTarget = "chat" | "artifact" | "file_agent";

export type TaskIntent = {
  type: TaskType;
  artifactKind?: ArtifactKind;
  needsSandbox: boolean;
  confidence: TaskConfidence;
  reason: string;
  routeTarget: RouteTarget;
};

export type ClassifyAttachment = { kind: "text" | "image"; mime?: string; name?: string };

export type ClassifyInput = {
  message: string;
  attachments?: ClassifyAttachment[];
  model?: { key?: string; vision?: boolean | "unknown" };
  settings?: { searchMode?: "off" | "auto" | "on" };
};

/* ---------- 规则信号（见 PHASE_A_TASK_ROUTER_DESIGN.md §5） ---------- */

/** R1：直接给文件（无类型名词也可判定）。 */
const DIRECT_FILE = /(不要贴代码|直接给文件|直接发文件|直接生成文件)/i;

/** R1：显式生成动词 + 具体文件类型名词（排除 解释/介绍/什么是 等提问）。 */
const ARTIFACT_PATTERN =
  /(做|生成|创建|给我|发|导出|做一份|做一个|写一个|写个|生成一个|写一份)(?![^，。；、\n]{0,20}(解释|介绍|什么是|讲|什么意思))[^，。；、\n]{0,14}(ppt|pptx|幻灯片|html|网页|index|csv|表格|markdown|\bmd\b|\bjson\b|zip|pdf|txt|text)/i;

/** R3a：图片引用 + 复刻/修改/生成动作。 */
const IMAGE_MODIFY_REF =
  /((按|根据|照|照着|按照|看)?\s*(这张|这|那张)?\s*(截图|图片|图|示意图|样子)).{0,14}(改|修改|复刻|做|生成|实现|调整|修复|重做|适配|优化)/i;
const IMAGE_MODIFY_RESULT =
  /((改|做成|改成|复刻成|调整成|还原成).{0,8}(这样|这个样子|这个效果|这个设计|图|截图))/i;

/** R3b：图片 + 修改类动词（无显式图引用，保守判为按图修改）。 */
const MODIFY_VERBS = /(修改|编辑|改|处理|整理|修复|重构|优化|清洗|适配|调整)/;

/** R4：图片纯问答 → chat。 */
const IMAGE_QA =
  /(看到|什么意思|讲什么|讲了什么|写了什么|是什么|描述|说明|含义|内容|怎么样|什么问题|有什么问题|分析|解释|介绍|认出|辨别)/i;

/** R2 前置：带文件但只是问内容 → chat。 */
const FILE_QA = /(总结|讲了什么|内容是什么|解释|介绍|翻译|帮我读|看看|说明|含义|是什么|讲一下|概括|概述|摘要)/;

/** R5：纯文本构建项目 / 多步执行 → agent_workspace。 */
const PROJECT_BUILD =
  /(搭|搭建|写一个|写个|开发|实现一个|创建一个|创建一套|做一个|构建|生成一套|搞一个).{0,12}(项目|网页项目|网站|小程序|工具|脚本|应用|代码|功能|文件|一套)/i;

function detectArtifactKind(message: string): ArtifactKind {
  const t = message.toLowerCase();
  if (/ppt|幻灯片/.test(t)) return "pptx";
  if (/html|网页|index/.test(t)) return "html";
  if (/csv|表格/.test(t)) return "csv";
  if (/markdown|\bmd\b/.test(t)) return "markdown";
  if (/\bjson\b/.test(t)) return "json";
  if (/zip|压缩包/.test(t)) return "zip";
  if (/txt|text/.test(t)) return "txt";
  return "unknown";
}

function artifactIntent(kind: ArtifactKind, reason: string): TaskIntent {
  return { type: "artifact", artifactKind: kind, needsSandbox: false, confidence: "high", reason, routeTarget: "artifact" };
}

/**
 * 分类用户请求。规则按优先级执行：
 * R0 空输入 → null（拒绝发送）｜ R1 显式文件生成 → artifact
 * R3 图片+修改/复刻 → agent_workspace ｜ R4 图片纯问答 → chat
 * R2 文件+修改 → agent_workspace ｜ R5 纯文本构建项目 → agent_workspace
 * R6 其余 → chat。
 */
export function classifyTask(input: ClassifyInput): TaskIntent | null {
  const message = String(input?.message || "").trim();
  const attachments = Array.isArray(input?.attachments) ? input.attachments : [];
  const hasFiles = attachments.some((a) => a?.kind === "text");
  const hasImages = attachments.some((a) => a?.kind === "image");

  // R0：空输入且无附件 → 拒绝发送。
  if (!message && attachments.length === 0) return null;

  // R1 特例：明确「直接给文件」。
  if (DIRECT_FILE.test(message)) return artifactIntent(detectArtifactKind(message), "explicit_direct_file");

  // R3a：图片引用 + 复刻/修改/生成动作。
  if (hasImages && (IMAGE_MODIFY_REF.test(message) || IMAGE_MODIFY_RESULT.test(message))) {
    return { type: "agent_workspace", needsSandbox: true, confidence: "high", reason: "image_replicate", routeTarget: "file_agent" };
  }

  // R3b：图片 + 修改类动词（无显式图引用，保守按图修改处理）。
  if (hasImages && MODIFY_VERBS.test(message)) {
    return { type: "agent_workspace", needsSandbox: true, confidence: "high", reason: "image_modify", routeTarget: "file_agent" };
  }

  // R4：图片纯问答。
  if (hasImages && IMAGE_QA.test(message)) {
    return { type: "chat", needsSandbox: false, confidence: "high", reason: "image_qa", routeTarget: "chat" };
  }

  // R1：显式文件生成。
  if (ARTIFACT_PATTERN.test(message)) {
    return artifactIntent(detectArtifactKind(message), "explicit_artifact");
  }

  // R2：带文件但只是问内容 → chat。
  if (hasFiles && FILE_QA.test(message)) {
    return { type: "chat", needsSandbox: false, confidence: "high", reason: "file_qa", routeTarget: "chat" };
  }

  // R2：文件 + 修改/整理/处理 → agent_workspace。
  if (hasFiles && MODIFY_VERBS.test(message)) {
    return { type: "agent_workspace", needsSandbox: true, confidence: "high", reason: "file_modify", routeTarget: "file_agent" };
  }

  // R5：纯文本构建项目 / 多步执行。
  if (!hasFiles && !hasImages && PROJECT_BUILD.test(message)) {
    return { type: "agent_workspace", needsSandbox: true, confidence: "medium", reason: "project_build", routeTarget: "file_agent" };
  }

  // R6：其余 → chat。
  return { type: "chat", needsSandbox: false, confidence: "medium", reason: "fallback_chat", routeTarget: "chat" };
}
