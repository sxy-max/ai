/**
 * Generator Boundary（V1.2 WP14）：哪些任务不该给 Agent（deterministic 边界）。
 * 集中声明：kind → 何时 deterministic / 何时必须 Agent。ExecutionPolicy 与审计引用。
 */

export type GeneratorBoundary = {
  kind: string;
  /** 该类型是否支持确定性生成。 */
  deterministic: boolean;
  /** 哪些情况下必须 Agent（关键词/信号）。 */
  agentRequiredWhen: string[];
  /** 边界说明。 */
  note: string;
};

export const GENERATOR_BOUNDARIES: Record<string, GeneratorBoundary> = {
  pptx: {
    kind: "pptx",
    deterministic: true,
    agentRequiredWhen: [],
    note: "LLM 生成 PresentationSpec（内容）→ pptxgenjs 确定性渲染。模型不直接输出页 Markdown 冒充 PPT。",
  },
  csv: {
    kind: "csv",
    deterministic: true,
    agentRequiredWhen: ["截图", "图片", "参考图", "根据图片", "分析后", "语义", "复杂", "清洗规则"],
    note: "明确排序/过滤/去重 → deterministic；复杂语义转换 → LLM/Agent + generator。",
  },
  xlsx: {
    kind: "xlsx",
    deterministic: true,
    agentRequiredWhen: ["截图", "图片", "参考图", "根据图片", "分析后", "语义", "复杂"],
    note: "结构化表格操作（列/排序/去重/新 sheet）→ deterministic；语义整理 → LLM + xlsx 渲染。",
  },
  html: {
    kind: "html",
    deterministic: true,
    agentRequiredWhen: ["截图", "参考图", "图片", "项目", "多文件", "修改现有", "重做", "复刻", "zip", "压缩包"],
    note: "“把这段文字包成 HTML” → generator；“根据截图设计网页” → Agent。",
  },
  markdown: {
    kind: "markdown",
    deterministic: true,
    agentRequiredWhen: ["修改现有", "按截图", "参考图", "多文件", "项目"],
    note: "文本整理 → generator/LLM 内容；文件修改 → Agent。",
  },
};

export function boundaryFor(kind: string): GeneratorBoundary | null {
  return GENERATOR_BOUNDARIES[kind] || null;
}

/** 该任务是否应使用 Agent（命中 agentRequiredWhen 信号）。 */
export function shouldUseAgent(kind: string, goal: string): boolean {
  const boundary = boundaryFor(kind);
  if (!boundary) return false;
  return boundary.agentRequiredWhen.some((signal) => goal.toLowerCase().includes(signal));
}
