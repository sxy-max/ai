import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPersonalizationContext,
  enabledMemoryText,
  personalizationSystemText,
  styleInstruction,
  type PersonalizationProfile,
} from "../lib/personalization";

const profile: PersonalizationProfile = {
  memory: [
    { id: "1", text: "我叫小 Y，前端工程师", enabled: true },
    { id: "2", text: "旧项目细节（已关闭）", enabled: false },
    { id: "3", text: "  工作语言是中文  ", enabled: true },
  ],
  style: { mode: "concise" },
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
