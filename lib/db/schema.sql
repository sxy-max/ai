-- Cloud AI Work System — V1 数据骨架（PRD §80）
-- 幂等：CREATE ... IF NOT EXISTS；lib/db/migrate.ts 负责执行并记录版本。
-- 所有主键用 UUID（应用层生成或 gen_random_uuid）。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============ 用户 / 会话 ============

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',                -- user | admin
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ============ Project / Conversation / Message ============

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                -- user | assistant | system
  parts JSONB NOT NULL DEFAULT '[]',
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- ============ Task（PRD §9）============

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|planning|running|waiting_user|completed|failed|cancelled|paused
  type TEXT NOT NULL DEFAULT 'artifact',  -- artifact|agent_workspace（任务路线，PRD LLM_EXECUTION_CHAIN §2.2）
  priority TEXT NOT NULL DEFAULT 'normal',-- low|normal|high
  current_stage TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,    -- 0-100
  plan JSONB NOT NULL DEFAULT '[]',       -- 步骤列表（Leader 输出）
  planner_run_id UUID,
  result_summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  worker_id TEXT NOT NULL DEFAULT '',      -- 当前领取的 worker（崩溃恢复用）
  lease_expires TIMESTAMPTZ,               -- 领取租约到期时间（孤儿回收判定）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_expires TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'artifact';
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status) WHERE status IN ('queued','planning','running');

-- 步骤（Plan 的执行实例）
CREATE TABLE IF NOT EXISTS task_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  worker_type TEXT NOT NULL,              -- general|research|artifact|dev
  phase TEXT NOT NULL DEFAULT '',        -- ANALYZE_INPUT|VISION_ANALYSIS|PREPARE_WORKSPACE|RUN_AGENT|GENERATE_ARTIFACT|VALIDATE_ARTIFACT|PACKAGE_OUTPUT
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|skipped|blocked|waiting_user
  detail JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT NOT NULL DEFAULT '',
  UNIQUE (task_id, seq)
);
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, seq);

-- Agent Run（PRD §81 AgentRun）
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  step_id UUID REFERENCES task_steps(id) ON DELETE CASCADE,
  worker_type TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|completed|failed|cancelled
  summary TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, created_at);

-- Tool Call
CREATE TABLE IF NOT EXISTS tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  status TEXT NOT NULL DEFAULT 'running',  -- running|success|failed
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(agent_run_id, started_at);

-- ============ Artifact（PRD §20）============

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                     -- markdown|html|docx|xlsx|pptx|csv|pdf|image|zip|code|text
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,     -- V1/V2/V3（同一 task+name 递增）
  storage_key TEXT NOT NULL,
  file_url TEXT NOT NULL DEFAULT '',
  preview_url TEXT NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',   -- ready|deleted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at DESC);

-- ============ File（PRD §30）============

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',  -- upload|agent|artifact|import
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);

-- ============ Memory / Knowledge（PRD §41-§43）============

CREATE TABLE IF NOT EXISTS user_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general', -- preference|work_style|output_habit|goal
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);

CREATE TABLE IF NOT EXISTS project_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory(project_id);

CREATE TABLE IF NOT EXISTS knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge(user_id, updated_at DESC);

-- ============ Skill（PRD §52）============

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = 系统内置
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules JSONB NOT NULL DEFAULT '[]',
  constraints JSONB NOT NULL DEFAULT '[]',
  examples JSONB NOT NULL DEFAULT '[]',
  version TEXT NOT NULL DEFAULT '1.0.0',
  status TEXT NOT NULL DEFAULT 'enabled',  -- enabled|disabled
  source TEXT NOT NULL DEFAULT 'builtin',  -- builtin|import|evolved
  evolution_log JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);

-- ============ Notification（PRD §65）============

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'task',
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

-- ============ Task 事件流（PRD §64，SSE 游标持久化）============

CREATE TABLE IF NOT EXISTS task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

-- ============ Quota（PRD §85：正式产品必须 Quota）============

CREATE TABLE IF NOT EXISTS quotas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  task_limit_per_day INTEGER NOT NULL DEFAULT 50,
  usage JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移版本记录
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ V1.2：Task Execution Metrics（WP20）============

CREATE TABLE IF NOT EXISTS task_metrics (
  task_id UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  queue_ms INTEGER,
  planning_ms INTEGER,
  runtime_ms INTEGER,
  validation_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  output_tokens INTEGER,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  runtime TEXT,
  model TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_metrics_user ON task_metrics(user_id, created_at);

-- ============ V1.3：Job State Machine（WP2）+ AgentSession（WP3）============

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  runtime TEXT,
  model TEXT,
  sandbox_id TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT,
  checkpoint JSONB NOT NULL DEFAULT '{}',
  failure_code TEXT,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  user_id UUID NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT,
  workspace_id TEXT,
  sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'created',
  current_step TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  context_version INTEGER NOT NULL DEFAULT 1,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_job ON agent_sessions(job_id);

-- ============ V1.3：Continue lineage（WP20）============

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS workspace_parent_version INTEGER;

-- ============ V1.3：Artifact Provenance（WP30）============

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS runtime TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS source_files JSONB NOT NULL DEFAULT '[]';
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS validator TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS validation_status TEXT;

-- agent_sessions.job_id 允许 NULL（直接执行 dev 步骤时无 job）
ALTER TABLE agent_sessions ALTER COLUMN job_id DROP NOT NULL;
