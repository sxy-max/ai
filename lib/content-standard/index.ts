/**
 * Go AI 统一用户内容标准（Unified Content Standard）。
 *
 * 两份用户提供的权威标准：
 *   1. structure-standard.md   —— HARD COMPOSITION CONTRACT（结构/推理主线/取舍/密度/上下文一致性/完成测试）
 *   2. 关系修辞表达生成器.md    —— EXPRESSION SCHEDULER（先判断关系，再选择修辞）
 *
 * 冲突整合（用户规则）——最终统一标准采用：
 *   HARD STRUCTURE FIRST + FUNCTIONAL RHETORIC SECOND
 *   1. 先满足中心判断和因果/关系主线。
 *   2. 再判断哪里真的存在：混淆 / 抽象 / 复杂机制 / 推进需要。
 *   3. 只有在对应关系存在时调用相应修辞。
 *   4. 修辞权重是选择优先级，不是机械句子配额。
 *   5. 如果某修辞没有使关系更清楚，则根据原文件自己的规则删除。
 *   6. 短答案不为了凑四种修辞强行扩写。
 *   7. 完整解释型/知识型/议论型长内容，应主动检查是否有机会使用高优先级修辞帮助理解。
 *   8. 可见输出默认不打印：现象/关系/机制/约束/推导/结论/迁移。
 *   9. 如果用户明确要求结构化提纲/报告，可以使用自然、内容相关的小标题。
 *   10. 不允许因为使用 Standard 而产生机械模板感。
 *
 * 注入原则：在 Claude Code 生成内容之前进入（Preflight/Context 层），不是事后第二模型润色。
 * Display 只负责渲染，不负责重新写作。
 */

import { STRUCTURE_STANDARD, STRUCTURE_STANDARD_SOURCE } from "./structureStandard";
import { RHETORIC_GENERATOR, RHETORIC_GENERATOR_SOURCE } from "./rhetoricGenerator";

export { STRUCTURE_STANDARD, STRUCTURE_STANDARD_SOURCE, RHETORIC_GENERATOR, RHETORIC_GENERATOR_SOURCE };

/** 内容复杂度三级（内部层级，不向用户显示名称）。 */
export type ContentComplexity = "short" | "normal" | "deep";

const DEEP_HINTS = [
  "分析", "比较", "评估", "报告", "综述", "对比", "优缺点", "架构", "调研",
  "研究", "总结", "长文", "决策", "选型", "方案", "论文", "文章", "文档",
  "analyze", "compare", "evaluate", "report", "research", "summary", "review",
  "pros and cons", "architecture", "decision", "trade-off",
];

const NORMAL_HINTS = [
  "为什么", "怎么理解", "原理", "机制", "本质", "解释", "区别", "差异",
  "关系", "原因", "影响", "概念", "怎么用", "如何", "有什么用", "作用",
  "表格", "excel", "ppt", "文档", "总结要点",
  "why", "explain", "what is", "difference", "mechanism", "how",
];

/**
 * 按任务目标文本检测内容复杂度。
 * - deep：明确的分析/比较/报告/研究/长文/决策意图，或长输入
 * - normal：概念解释 / 机制 / 区别类提问
 * - short：简短、直接、事实类提问（默认）
 */
export function detectContentComplexity(text: string, options?: { inputLength?: number; outputKind?: string }): ContentComplexity {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "normal";
  const length = options?.inputLength ?? t.length;
  const out = options?.outputKind;

  // 明确的长内容输出意图（文档/PPT/网页/文章/报告）→ deep
  if (out && /(document|markdown|pptx|pdf|docx|webpage|html|report)/i.test(out)) return "deep";
  if (/(写|生成|输出).*(文档|文章|报告|白皮书)|生成.*(md|markdown)|长篇|详细分析|全面分析/.test(t)) return "deep";
  if (length > 160) return "deep";

  const deepHits = DEEP_HINTS.filter((h) => t.includes(h)).length;
  const normalHits = NORMAL_HINTS.filter((h) => t.includes(h)).length;
  if (deepHits >= 1 && deepHits >= normalHits) return "deep";
  if (normalHits >= 1) return "normal";

  // 事实型短问（"HTTP 400 是什么意思？" ~12 字）→ short：直接关键关系，不扩写
  if (length <= 24 && /是什么意思|是什么|有什么用|怎么用|怎么读|干嘛|干啥|咋用|含义/.test(t)) return "short";
  if (length <= 24) return "short";
  return "normal";
}

/**
 * 按复杂度生成注入文本（Chat system / 任务上下文共用）。
 * 短答案：只保留「不扩写 + 直接给关键关系」的护栏，不加载全套规则（上下文不膨胀）。
 * 普通解释：中心判断 + 主线 + 机制 + 边界 + 修辞调度（关系驱动）。
 * 深度内容：完整整合标准。
 */
export function contentStandardText(complexity: ContentComplexity): string {
  const header = `[GO AI CONTENT STANDARD]
用户可见的解释、分析、比较、推荐、研究、知识回答与文档内容，必须按以下标准组织。
它不适用于代码源码、JSON、日志、工具结果、命令输出、机器状态与错误栈（这些保持原生结构）。
`; // 注入主体由 buildContentStandard 生成
  void header;
  return buildContentStandard(complexity);
}

/** 短答护栏：只做最小干预。 */
function shortRule(): string {
  return `[GO AI CONTENT STANDARD — 短答]
- 直接回答关键关系和结果，一个问题一个中心判断。
- 不为显得完整而扩写：不需要类比/比喻/长例子/七段结构。
- 不重复同一结论的多种说法；说完关系模型就结束。
[END GO AI CONTENT STANDARD]`;
}

/** 普通解释层：中心判断 + 主线 + 机制 + 边界 + 修辞按关系调用。 */
function normalRule(): string {
  return `[GO AI CONTENT STANDARD — 解释]
本标准适用于用户可见的解释、分析、比较、推荐、研究、知识回答与文档内容；不适用于代码源码、JSON、日志、工具结果、命令输出、机器状态与错误栈（这些保持原生结构）。
写作前内部确定：读者读完最应该突然明白什么？（只能有一个主判断），然后建立一条关系主线。
内部推理脊柱：现象 → 关系 → 机制 → 约束 → 推导 → 结论 → 迁移。这些词默认不打印在输出里。

结构与密度：
- 一个中心判断、一条主线、只在真正会混淆处拆开概念、必要边界、模型完整后及时结束。
- 例子只在能暴露隐藏关系时使用（对象 → 动作 → 变量变化 → 结果变化 → 为什么；必要时做反事实）。
- 能删的段落就删；不堆术语、不情绪化铺垫、不把同一结论换三种说法重复。
- 讲机制不要只说"X 很重要因为有 A/B/C 优点"，要表达：X 改变了哪个变量 → 这个变量让什么发生 → 后面的现象为什么出现。
- 比较概念/选项/系统时：不同输入/状态 → 不同机制 → 不同输出 → 不同选择；不要堆 Feature List。
- 概念解释不要从教科书定义开始：什么变了 → 什么没变 → 什么关系连接它们 → 为什么重要 → 得出什么。
- 决策类问题：目标 → 决定性变量 → 约束 → 各选项在这些变量下的行为 → 权衡 → 选择。

修辞调度（关系驱动，不是配额）：
先判断关系再选修辞；每个修辞必须回答"它让哪个关系变清楚了？"，答不上就删。
- 对比负责划边界（拆开容易混淆的概念）；类比负责映射结构；比喻负责降低抽象；设问负责推进阅读路径。
- 排比用于真正存在多个并列变量；反复用于钉住中心判断；衬托/反衬在差异本身能帮助理解时使用；对偶适合收束。
- 双关、借代默认禁用。
- 短答案不为凑修辞扩写；完整解释/知识/议论型内容，主动检查是否有机会用上述修辞帮助理解。

完成前检查：有清晰中心判断吗？推理沿一条因果线可追溯吗？机制被展示而不是被点名？例子暴露差异而不是装饰？
可见输出默认不打印 现象/关系/机制/约束/推导/结论/迁移 标签；用户明确要求结构化提纲/报告时，用自然、内容相关的小标题。
[END GO AI CONTENT STANDARD]`;
}

/** 深度内容层：完整整合（结构硬约束 + 关系驱动修辞 + 自适应）。 */
function deepRule(): string {
  return `[GO AI CONTENT STANDARD — 深度内容]
适用于完整解释/分析/比较/研究报告/长文档。HARD STRUCTURE FIRST + FUNCTIONAL RHETORIC SECOND。

一、结构（硬约束，来源：structure-standard.md）
写作前内部确定：读者读完最应该突然明白什么？只能有一个主判断，然后建立一条关系主线。
内部推理脊柱：现象 → 关系 → 机制 → 约束 → 推导 → 结论 → 迁移（不机械打印这些标签）。
输出架构：一个中心判断 + 一条主线 + 在会混淆处拆开概念 + 真正暴露差异的例子 + 必要边界 + 及时结束。
机制表达：不要"X 很重要因为有 A/B/C 优点"，要表达 X 改变了哪个变量 → 这个变量让什么发生 → 后面的现象为什么出现。
比较：不同输入/状态 → 不同机制 → 不同输出 → 不同决策；不用无关 Feature List 堆砌。
例子是测试不是装饰：对象 → 动作 → 变量变化 → 结果变化 → 为什么；必要时做反事实（如果变量不变，结果还会发生吗？）。
决策题：目标 → 决定性变量 → 约束 → 选项行为 → 权衡 → 选择；选项列表是决策模型的输出，不是模型本身。
概念解释：不从教科书定义开始（除非定义本身就解决混淆）：什么变了 → 什么没变 → 什么关系连接 → 为什么重要 → 得出什么。
密度：避免泛科普、情绪铺垫、绕路故事、术语堆、同结论复述、低密度扩写、虚假精确。
完成测试：有清晰中心判断？推理可沿一条因果线追溯？易混概念在需要处被拆开？机制被展示而非只被点名？例子暴露差异？有必要边界？读者能把模型用到新场景？能删的段落删了吗？

二、修辞调度（关系驱动，来源：关系修辞表达生成器.md）
先判断关系，再选择修辞；不得先选修辞再塞内容。每个修辞必须回答"它让哪个关系变清楚了？"，答不上就删。
- 高频（每篇解释/知识/议论型内容主动检查）：对比（切开混淆，划边界）、类比（映射结构）、比喻（降低抽象）、设问（推进阅读路径）。
- 中低频按场景：排比（多个并列变量）、反复（钉住中心判断）、衬托/反衬（差异帮助理解时）、对偶（收束关系）。
- 默认禁用：双关、借代。
- 修辞权重是选择优先级，不是机械句子配额；如果某修辞没有使关系更清楚，按原文件规则删除。
- 句式模板（可参考）："不是 A，而是 B"；"X 更像 Y，相似点在结构"；"为什么会这样？因为……"；"关键不是……，关键是……"。

三、复杂度自适应（内部层级）
短答（如"HTTP 400 是什么意思？"）：直接说关键关系和结果，不强迫类比/比喻/长例子/七段结构。
普通解释（如"PCB 打样是什么意思？"）：中心判断 + 概念关系 + 机制 + 必要例子 + 边界。
深度内容（技术架构比较、研究报告）：完整使用结构链 + 关系比较 + 机制 + 约束 + 推导 + 迁移 + 合适修辞辅助。

四、反模板护栏
- 可见输出默认不打印：现象/关系/机制/约束/推导/结论/迁移。
- 不允许每个答案固定七个标题；不允许每个回答必出现"为什么会这样？"。
- 短问题不强行塞比喻；不为完成修辞比例制造无意义类比。
- 一个结论不换三种说法重复；不堆术语；不给每段添加无意义总结。
- 用户明确要求结构化提纲/报告时，才使用自然、内容相关的小标题。
- 上下文一致性：用户的新纠正高于旧习惯；指出错误即替换旧规则并传播，绝不静默回退。
[END GO AI CONTENT STANDARD]`;
}

export function buildContentStandard(complexity: ContentComplexity): string {
  if (complexity === "short") return shortRule();
  if (complexity === "normal") return normalRule();
  return deepRule();
}

/** 纯代码/机械任务信号：不套文章标准（标准内也有「代码/JSON/日志保持原生」声明，这里是注入层再滤一次）。 */
const MECHANICAL_SIGNALS = [
  "修复", "报错", "错误", "编译", "运行", "函数", "接口", "docker", "部署",
  "配置", "sql", "bug", "error", "fix", "exception", "debug", "npm", "git",
  "crash", "segfault", "超时", "报错信息", "日志", "堆栈", "test", "测试用例",
  "实现一个程序", "写程序", "代码", "json", "接口文档",
];

/** 面向任务的统一入口：goal + 类型 → 注入文本（任务路径使用）。
 *  纯代码/JSON/日志/命令类任务不注入（任务 §24）；其余按复杂度裁剪。 */
export function standardForTask(goal: string, taskType?: string, outputKind?: string): string {
  const t = (goal || "").toLowerCase();
  const mechanical = MECHANICAL_SIGNALS.filter((s) => t.includes(s)).length;
  // 机械信号 ≥2 或出现强代码词（修复/报错/bug/error/debug/编译/日志）→ 不注入
  if (mechanical >= 2 || /(修复.*(bug|错误|报错)|报错|error.*fix|debug|编译错误|运行错误|日志)/.test(t)) return "";
  const complexity = detectContentComplexity(goal, { outputKind });
  return contentStandardText(complexity);
}
