import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPersonalizationContext,
  enabledMemoryText,
  parseSkillMarkdown,
  personalizationSystemText,
  selectRelevantSkills,
  skillsSystemText,
  styleInstruction,
  type PersonalizationProfile,
  type SkillItem,
} from "../lib/personalization";

const profile: PersonalizationProfile = {
  memory: [
    { id: "1", text: "我叫小 Y，前端工程师", enabled: true },
    { id: "2", text: "旧项目细节（已关闭）", enabled: false },
    { id: "3", text: "  工作语言是中文  ", enabled: true },
  ],
  style: { mode: "concise" },
  skills: [],
};

test("enabled memory text keeps enabled entries trimmed", () => {
  const text = enabledMemoryText(profile);
  assert.match(text, /我叫小 Y/);
  assert.doesNotMatch(text, /旧项目细节/);
  assert.match(text, /工作语言是中文/);
  assert.ok(!text.includes("（已关闭）"));
});

test("style instruction by preset and custom rules", () => {
  assert.equal(styleInstruction({ mode: "balanced" }), "");
  assert.match(styleInstruction({ mode: "concise" }), /简洁/);
  assert.match(styleInstruction({ mode: "detailed" }), /详尽/);
  assert.equal(styleInstruction({ mode: "custom" }), "");
  assert.equal(styleInstruction({ mode: "custom", customRules: "先给结论" }), "先给结论");
  assert.equal(styleInstruction({ mode: "custom", customRules: "   " }), "");
});

test("buildPersonalizationContext is pure and drops disabled memory", () => {
  const ctx = buildPersonalizationContext(profile);
  assert.match(ctx.memory, /我叫小 Y/);
  assert.doesNotMatch(ctx.memory, /旧项目细节/);
  assert.match(ctx.style, /简洁/);
});

test("system text wraps context with markers and omits empty blocks", () => {
  const wrapped = personalizationSystemText({ memory: "我叫小 Y", style: "先给结论" });
  assert.match(wrapped, /\[USER MEMORY\]/);
  assert.match(wrapped, /\[RESPONSE STYLE\]/);
  assert.match(wrapped, /先给结论/);
  const onlyStyle = personalizationSystemText({ memory: "", style: "简洁一点" });
  assert.doesNotMatch(onlyStyle, /USER MEMORY/);
  assert.match(onlyStyle, /RESPONSE STYLE/);
  assert.equal(personalizationSystemText({ memory: "", style: "" }), "");
});

test("parseSkillMarkdown extracts frontmatter and falls back to heading", () => {
  const withFront = parseSkillMarkdown("---\nname: 前端重构\n---\n# 标题\n\n按以下步骤重构：\n1. 分析\n2. 修改\n", "whatever.md");
  assert.equal(withFront?.name, "前端重构");
  assert.match(withFront!.content, /重构/);
  const h1 = parseSkillMarkdown("# 学术写作助手\n\n优先给结论", "unknown.txt");
  assert.equal(h1?.name, "学术写作助手");
  assert.match(h1!.description, /优先给结论/);
  const byFile = parseSkillMarkdown("普通内容", "my-skill.md");
  assert.equal(byFile?.name, "my-skill");
  assert.equal(parseSkillMarkdown("   \n  ", "x.md"), null);
});

test("skillsSystemText marks user skills as non-privileged", () => {
  const text = skillsSystemText([{ name: "前端重构", content: "按步骤执行" }]);
  assert.match(text, /\[USER SKILLS\]/);
  assert.match(text, /前端重构/);
  assert.match(text, /不授予任何工具\/命令权限/);
  assert.equal(skillsSystemText([]), "");
});

test("selectRelevantSkills picks by name/description bigrams, never all", () => {
  const skills: SkillItem[] = [
    { id: "1", name: "前端重构", description: "重构 React 组件，拆分逻辑", content: "重构步骤…", enabled: true },
    { id: "2", name: "学术写作", description: "论文结构、引用规范", content: "写作规范…", enabled: true },
    { id: "3", name: "已关闭技能", description: "无关内容", content: "x", enabled: false },
    { id: "4", name: "marketing copy", description: "广告文案，种草文案", content: "文案模板…", enabled: true },
  ];
  const front = selectRelevantSkills(skills, "帮我重构这个前端组件");
  assert.ok(front.some((s) => s.name === "前端重构"));
  assert.ok(!front.some((s) => s.name === "已关闭技能"));
  const academic = selectRelevantSkills(skills, "写一篇学术论文");
  assert.ok(academic.some((s) => s.name === "学术写作"));
  const copy = selectRelevantSkills(skills, "写 marketing 文案");
  assert.ok(copy.some((s) => s.name === "marketing copy"));
  const none = selectRelevantSkills(skills, "天气怎么样");
  assert.equal(none.length, 0);
  assert.ok(selectRelevantSkills(skills, "前端 重构 学术 文案 全部 提一下").length <= 3);
});
