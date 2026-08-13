/**
 * 个性化（浏览器本地 Profile，无账号系统）。
 * Memory / Response Style 在此定义、持久化、并构建注入上下文。
 *
 * 注入原则：
 * - 作为独立 personalization context 进入 system，绝不粗暴拼进 user prompt；
 * - 安全规则优先级永远高于个人化偏好；
 * - 不共享服务器全局 Profile（每浏览器独立）。
 */

export type MemoryItem = { id: string; text: string; enabled: boolean };

export type StyleMode = "concise" | "balanced" | "detailed" | "custom";

export type StylePref = { mode: StyleMode; customRules?: string };

export type PersonalizationProfile = {
  memory: MemoryItem[];
  style: StylePref;
};

export const PERSONALIZATION_KEY = "go-ai-personalization-v1";

export const STYLE_PRESETS: Record<StyleMode, { label: string; description: string; instruction: string }> = {
  concise: {
    label: "简洁",
    description: "直接给结论与要点",
    instruction: "回答尽量简洁直接，减少铺垫与重复，优先给结论、要点和可执行步骤。",
  },
  balanced: {
    label: "均衡",
    description: "默认：结论 + 必要展开",
    instruction: "",
  },
  detailed: {
    label: "详细",
    description: "详尽背景、步骤与边界",
    instruction: "回答尽量详尽，提供背景、步骤与边界说明，结构清晰，不要过度省略。",
  },
  custom: {
    label: "自定义",
    description: "用户自定义回答规则",
    instruction: "",
  },
};

export function defaultProfile(): PersonalizationProfile {
  return { memory: [], style: { mode: "balanced" } };
}

/** 读取本地 Profile；损坏/缺失时回退默认。 */
export function loadProfile(): PersonalizationProfile {
  try {
    const raw = globalThis.localStorage?.getItem(PERSONALIZATION_KEY);
    if (!raw) return defaultProfile();
    const p = JSON.parse(raw) as Partial<PersonalizationProfile>;
    const memory = Array.isArray(p.memory)
      ? p.memory
        .filter((m: any) => m && typeof m === "object" && typeof m.text === "string")
        .slice(0, 60)
        .map((m: any) => ({
          id: typeof m.id === "string" ? m.id : String(Math.random()).slice(2),
          text: m.text.slice(0, 2000),
          enabled: m.enabled !== false,
        }))
      : [];
    const style: StylePref =
      p.style && typeof p.style === "object" && ["concise", "balanced", "detailed", "custom"].includes(p.style.mode)
        ? { mode: p.style.mode as StyleMode, customRules: typeof p.style.customRules === "string" ? p.style.customRules.slice(0, 3000) : undefined }
        : { mode: "balanced" };
    return { memory, style };
  } catch {
    return defaultProfile();
  }
}

/** 保存本地 Profile。 */
export function saveProfile(profile: PersonalizationProfile) {
  try {
    globalThis.localStorage?.setItem(PERSONALIZATION_KEY, JSON.stringify(profile));
  } catch {}
}

/** 已启用记忆的纯文本。 */
export function enabledMemoryText(profile: PersonalizationProfile): string {
  return profile.memory
    .filter((m) => m.enabled && m.text.trim())
    .map((m) => `- ${m.text.trim()}`)
    .join("\n");
}

/** 风格指令（自定义时用用户规则）。 */
export function styleInstruction(style: StylePref): string {
  if (style.mode === "custom") return style.customRules?.trim() || "";
  return STYLE_PRESETS[style.mode].instruction;
}

/** 构建注入上下文的独立字符串。纯函数，可单测。 */
export function buildPersonalizationContext(profile: PersonalizationProfile): { memory: string; style: string } {
  return { memory: enabledMemoryText(profile), style: styleInstruction(profile.style) };
}

/** 组装成服务端 system 段（带标记，作为独立 context，不进入 user prompt）。 */
export function personalizationSystemText(ctx: { memory: string; style: string }): string {
  const blocks: string[] = [];
  if (ctx.memory.trim()) blocks.push(`[USER MEMORY]\n${ctx.memory.trim()}\n[END USER MEMORY]`);
  if (ctx.style.trim()) blocks.push(`[RESPONSE STYLE]\n${ctx.style.trim()}\n[END RESPONSE STYLE]`);
  return blocks.join("\n\n");
}
