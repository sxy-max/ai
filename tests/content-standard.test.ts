/**
 * Content Standard 单测（任务 §27-28 回归护栏）：
 * - 复杂度分层：短问 short / 概念 normal / 分析 deep
 * - 短答不膨胀：short 文本无修辞配额要求
 * - 反模板护栏存在：deep 不含「七段标题」「每答必设问」
 * - 代码/机械任务不注入（§24）
 * - 两份原文完整保留（structureStandard / rhetoricGenerator 常量）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectContentComplexity, contentStandardText, standardForTask, STRUCTURE_STANDARD, RHETORIC_GENERATOR } from "../lib/content-standard/index";
import { detectSkill, skillInstruction } from "../lib/skills";

test("复杂度分层：短问 → short", () => {
  assert.equal(detectContentComplexity("HTTP 400 是什么意思？"), "short");
  assert.equal(detectContentComplexity("什么是哈希表"), "short");
});

test("复杂度分层：概念解释 → normal", () => {
  assert.equal(detectContentComplexity("PCB 打样是什么意思？为什么需要打样而不是直接量产？"), "normal");
  assert.equal(detectContentComplexity("矩阵是什么，有什么用？"), "normal");
});

test("复杂度分层：分析/比较/长文 → deep", () => {
  assert.equal(detectContentComplexity("比较 Claude Code 和普通大模型 API 的核心区别，给出选型建议"), "deep");
  assert.equal(detectContentComplexity("写一篇关于分布式系统一致性的详细分析报告"), "deep");
  assert.equal(detectContentComplexity("PCB、电路板、PCB打样、嵌入式之间到底是什么关系？请深入分析"), "deep");
});

test("短答护栏：不要求修辞配额、不要求七段结构", () => {
  const text = contentStandardText("short");
  assert.ok(text.includes("不扩写") || text.includes("不为显得完整"));
  assert.ok(!text.includes("对比负责划边界")); // short 层不加载完整修辞调度
  assert.ok(!text.includes("现象 → 关系 → 机制")); // 不打印内部标签
});

test("deep 层：硬结构 + 关系驱动修辞 + 反模板护栏齐备", () => {
  const text = contentStandardText("deep");
  // 冲突整合规则（§20）：HARD STRUCTURE FIRST + FUNCTIONAL RHETORIC SECOND
  assert.ok(text.includes("HARD STRUCTURE FIRST") && text.includes("FUNCTIONAL RHETORIC SECOND"));
  // 修辞是选择优先级不是配额
  assert.ok(text.includes("不是机械句子配额") || text.includes("选择优先级"));
  // 每个修辞回答「它让哪个关系变清楚了」
  assert.ok(text.includes("它让哪个关系变清楚了"));
  // 反模板：不打印七个标签
  assert.ok(text.includes("默认不打印") && text.includes("现象"));
  // 反模板：不允许每答必设问
  assert.ok(text.includes("不允许每个回答必出现") || text.includes("不强行塞比喻"));
  // 复杂度自适应描述
  assert.ok(text.includes("短答") && text.includes("普通解释") && text.includes("深度内容"));
});

test("代码/机械任务不注入（§24）", () => {
  assert.equal(standardForTask("修复 nginx 502 报错，检查配置和日志"), "");
  assert.equal(standardForTask("这段 Python 代码报 TypeError，帮我 debug"), "");
  assert.equal(standardForTask("部署 docker 容器，配置环境变量"), "");
});

test("用户可见内容任务注入", () => {
  assert.ok(standardForTask("HTTP 400 是什么意思？").includes("CONTENT STANDARD"));
  assert.ok(standardForTask("矩阵是什么，有什么用？").includes("CONTENT STANDARD"));
  assert.ok(standardForTask("比较两种技术架构并给出选型建议").includes("CONTENT STANDARD"));
});

test("Chat short concept questions load the short content standard", () => {
  const messages = [{ role: "user", content: "HTTP 400 是什么意思？" }];
  assert.equal(detectSkill(messages), "academic");
  assert.match(skillInstruction(detectSkill(messages), messages[0].content), /CONTENT STANDARD.*短答/s);
});

test("两份权威原文完整保留（未被改写语义）", () => {
  // structure-standard：核心推理链 + 完成测试
  assert.ok(STRUCTURE_STANDARD.includes("phenomenon → relationship → mechanism → constraints → deduction → conclusion → transfer"));
  assert.ok(STRUCTURE_STANDARD.includes("Do not mechanically print these labels"));
  assert.ok(STRUCTURE_STANDARD.includes("Completion test"));
  assert.ok(STRUCTURE_STANDARD.includes("different input / state → different internal mechanism → different output → different decision"));
  // 关系修辞表达生成器：修辞权重表 + 关系→修辞 + 禁用修辞
  assert.ok(RHETORIC_GENERATOR.includes("对比") && RHETORIC_GENERATOR.includes("类比") && RHETORIC_GENERATOR.includes("比喻") && RHETORIC_GENERATOR.includes("设问"));
  assert.ok(RHETORIC_GENERATOR.includes("双关") && RHETORIC_GENERATOR.includes("借代"));
  assert.ok(RHETORIC_GENERATOR.includes("不得先选修辞，再硬套内容"));
  assert.ok(RHETORIC_GENERATOR.includes("修辞不是文章的装饰层"));
});
