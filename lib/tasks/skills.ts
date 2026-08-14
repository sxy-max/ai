/** Skill 数据访问（PRD §52-§53）：系统内置 + 用户导入/进化。 */

import { query } from "../db/pool";

export type SkillRow = {
  id: string;
  user_id: string | null;
  name: string;
  description: string;
  rules: Array<Record<string, unknown> | string>;
  constraints: Array<Record<string, unknown> | string>;
  examples: Array<Record<string, unknown> | string>;
  version: string;
  status: "enabled" | "disabled";
  source: "builtin" | "import" | "evolved";
  evolution_log: Array<Record<string, unknown>>;
  created_at: Date;
  updated_at: Date;
};

/** 内置技能种子（PRD §52 Skill Registry 示例）。 */
export const BUILTIN_SKILLS: Array<{ name: string; description: string; rules: string[]; constraints: string[] }> = [
  {
    name: "移动端网页",
    description: "制作移动端优先、信息层级清晰、可搜索定位的 HTML 页面",
    rules: ["移动端优先：先排手机布局，再放大到桌面", "窄屏无横向滚动", "信息层级清晰：标题-摘要-细节", "可搜索、可定位"],
    constraints: ["不使用外部 CDN（离线可用）", "配色走内容结构优先，避免无意义装饰"]
  },
  {
    name: "研究报告",
    description: "研究类任务的证据收集与报告结构",
    rules: ["事实标注来源，禁止编造", "区分事实/推断/冲突/未知", "先证据后结论"],
    constraints: ["搜索不到的明确写“无法确认”"]
  },
  {
    name: "PPT 制作",
    description: "把内容组织成视觉叙事演示文稿",
    rules: ["每页一个观点", "图表优先于文字", "叙事结构：问题-分析-结论"],
    constraints: ["不用整页文字段落"]
  },
  {
    name: "表格整理",
    description: "把散乱数据整理成规范表格",
    rules: ["识别表头", "保持数据原样不编造", "数值型列可排序"],
    constraints: ["不把 markdown 表格冒充 Excel"]
  }
];

async function seedBuiltinSkills() {
  for (const skill of BUILTIN_SKILLS) {
    // user_id 为 NULL 时 UNIQUE(user_id,name) 不生效（NULL 不冲突），用 NOT EXISTS 去重
    await query(
      `INSERT INTO skills (user_id, name, description, rules, constraints, source)
       SELECT NULL, $1, $2, $3::jsonb, $4::jsonb, 'builtin'
       WHERE NOT EXISTS (SELECT 1 FROM skills WHERE user_id IS NULL AND name = $1)`,
      [skill.name, skill.description, JSON.stringify(skill.rules), JSON.stringify(skill.constraints)]
    );
  }
}

let seeded = false;
export async function ensureBuiltinSkills() {
  if (seeded) return;
  seeded = true;
  await seedBuiltinSkills();
}

export async function listSkills(userId: string | null): Promise<SkillRow[]> {
  await ensureBuiltinSkills();
  const result = await query<SkillRow>(
    `SELECT * FROM skills WHERE user_id = $1 OR user_id IS NULL ORDER BY user_id IS NOT NULL, updated_at DESC`,
    [userId]
  );
  return result.rows;
}

export async function listEnabledSkills(userId: string): Promise<SkillRow[]> {
  await ensureBuiltinSkills();
  const result = await query<SkillRow>(
    `SELECT * FROM skills WHERE (user_id = $1 OR user_id IS NULL) AND status = 'enabled' ORDER BY user_id IS NOT NULL`,
    [userId]
  );
  return result.rows;
}

/** 注入 worker 的 skills 文本（名称 + 规则摘要）。 */
export async function listEnabledSkillsText(userId: string): Promise<string> {
  const skills = await listEnabledSkills(userId);
  if (!skills.length) return "";
  return skills.map((skill) => `【${skill.name}】${skill.description}\n${skill.rules.map((r) => `- ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n")}`).join("\n\n");
}

export async function importSkill(input: {
  userId: string;
  name: string;
  description?: string;
  rules?: string[];
  constraints?: string[];
  examples?: string[];
  source?: SkillRow["source"];
}): Promise<SkillRow> {
  const result = await query<SkillRow>(
    `INSERT INTO skills (user_id, name, description, rules, constraints, examples, source)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
     ON CONFLICT (user_id, name) DO UPDATE SET
       description = EXCLUDED.description, rules = EXCLUDED.rules, constraints = EXCLUDED.constraints,
       examples = EXCLUDED.examples, version = to_char(now(), '1.0.yyyyMMdd'), updated_at = now()
     RETURNING *`,
    [
      input.userId,
      input.name.trim(),
      input.description?.trim() || "",
      JSON.stringify(input.rules || []),
      JSON.stringify(input.constraints || []),
      JSON.stringify(input.examples || []),
      input.source || "import"
    ]
  );
  return result.rows[0];
}

export async function setSkillStatus(userId: string, id: string, status: "enabled" | "disabled") {
  // 内置技能（user_id IS NULL）全局共享：只有 admin 可改，避免一人禁用影响全员
  await query(
    `UPDATE skills SET status = $3, updated_at = now()
     WHERE id = $1 AND (
       user_id = $2 OR
       (user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = $2 AND role = 'admin'))
     )`,
    [id, userId, status]
  );
}

export async function deleteSkill(userId: string, id: string) {
  await query("DELETE FROM skills WHERE id = $1 AND user_id = $2", [id, userId]);
}
