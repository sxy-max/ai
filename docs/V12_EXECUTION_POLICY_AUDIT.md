# V12 Execution Policy Audit（2026-08-15，V1.2 WP1）

追踪 V1.1 执行主链的决策点，找出"模型/运行时/预算"三个隐性耦合，作为 V1.2 改造基线。

## 六路径现状

| 路径 | 主链 | 决策点 |
|------|------|--------|
| A 普通问答 | 前端 classifyTask→chat | /api/chat：模型由用户在前端选择，服务端只做参数策略（modelPolicy.ts） |
| B 复杂推理 | chat + 用户选 deepseek-v4-pro | maxOutputTokens 由客户端设置面板（默认 8192）；WP14 截断重试固定 16K |
| C PPTX | classifyTask→artifact→worker→artifact 步骤 | llmArtifactContent（completeChat 默认模型）→ PresentationSpec → pptxgenjs |
| D 图片+HTML | classifyTask→agent_workspace→dev 步骤 | devExecutor：vision→workspace→GoFileAgentAdapter（Claude Code 容器） |
| E ZIP | 同 D（hasZip 分支） | devExecutor 内 maxAttempts=3 |
| F MD/CSV 文件处理 | agent_workspace→dev 步骤 | 与 D 同链（GoFileAgentAdapter）；CSV 也可走 artifact 链（generator） |

## 14 问（逐条结论）

1. **谁决定 model？**
   - chat：**用户在前端选择**（模型列表来自 /api/models 的 opencode 能力元数据）；服务端只做 temperature/reasoning 参数策略（lib/modelPolicy.ts，仅 kimi 特例）。
   - 任务链（planner/general/artifact/content）：**completeChat 的 configuredPlannerProvider()**（OPENCODE_GO_API_KEY → PLANNER_MODEL 默认 deepseek-v4-pro）。
   - dev 步骤（Agent）：**devExecutor 写死 GoFileAgentAdapter**（AGENT_MODEL 默认 deepseek-v4-flash）。
   - 结论：**模型选择散落在 4 处**，无统一策略层。

2. **谁决定 runtime？**
   - dev 步骤：devExecutor 直接 `new GoFileAgentAdapter()`——**写死 Claude Code 容器**。AgentScopeRuntimeAdapter 存在但**无任何调用方**（execute 里没有引用）。
   - artifact 步骤：deterministic generator（无 runtime）。
   - 结论：**Runtime 选择 = 代码写死**，不在 plan/policy 中。

3. **谁决定 maxOutputTokens？**
   - chat：客户端设置（服务端 normalizedOptions 默认 MAX_OUTPUT_TOKENS=8192，上限 32K）。
   - planner/general/research/content：completeChat 内写死 2048/4096/8192。
   - dev：容器侧（file-agent 内部，任务侧不可控）。
   - 结论：**预算写死在各调用点**，无 TokenBudgetManager。

4. **谁决定 reasoning？**
   - chat：客户端 reasoningEffort（服务端注入 instruction 或参数）。
   - 任务链：无显式 reasoning 策略（模型自带）。
   - 结论：无策略。

5. **谁决定是否进入 Agent？**
   - 前端 classifyTask（规则 R1-R6）→ type=agent_workspace/artifact/chat；服务端 /api/tasks 有 422 防线。
   - worker 按 plan（planner）→ dev 步骤 → runDevStep。
   - 结论：**TaskClassifier 是唯一入口，但分类结果只到"任务类型"，不产生模型/runtime 策略**。

6. **谁决定使用 Claude Code？**
   - devExecutor 的 `new GoFileAgentAdapter()`——代码级决定，**plan 里没有 runtime 字段**。

7. **谁决定 Vision？**
   - devExecutor 内 scanWorkspaceVision（input 有图片即扫描）；chat 侧 attachImages 预处理（非 vision 模型）。
   - 结论：按"有图"隐式触发，无能力判断。

8. **谁决定确定性 generator？**
   - worker 的 plan：artifact 步骤（planner 关键词规则）→ runArtifact → kind 判断 → generateArtifact。
   - 结论：**planner 关键词决定**，ExecutionPlan 的 expectedArtifacts 与 executor 内部再次 artifactKindFromGoal 判定（两处重复）。

9. **Planner 是否知道模型能力？**
   - **否**。PLANNER_SYSTEM_PROMPT 只给 4 种 worker_type；generatePlan 只区分 task.type。

10. **Runtime 是否知道模型能力？**
    - **否**。GoFileAgentAdapter 只转发 model 字符串；AgentScopeRuntimeAdapter 写死 deepseek-v4-pro 配置。

11. **retry 是否会重新选择模型？**
    - **否**。devExecutor repair loop 只重写 prompt；chat WP14 只提高预算；均不换模型/runtime。

12. **artifact 类型是否影响模型选择？**
    - 部分：kind 影响是否走 LLM 内容（llmArtifactContent）与 generator；但模型固定（PLANNER_MODEL），无按 kind 的模型策略。

13. **任务失败是否可以 fallback runtime？**
    - **否**。DEV_RUNTIME_UNAVAILABLE 直接抛错（明确失败），无 runtime fallback 链。

14. **provider limitation 当前散落在哪里？**
    - lib/modelErrors.ts（错误码翻译）、/api/models（能力元数据）、lib/quota.ts（配额）、server 配置（AWS_REGION 等）。
    - 无集中 ProviderHealthRegistry。

## 隐性耦合清单（V1.2 必须拆）

1. **Planner ↔ 模型**：generatePlan/llmArtifactContent 直接调 completeChat 默认模型，无 policy 传入。
2. **Executor ↔ Runtime**：runDevStep 写死 GoFileAgentAdapter；AgentScopeRuntimeAdapter 无调用方。
3. **预算 ↔ 调用点**：maxTokens 散落（2048/4096/8192/固定 16K retry），无统一预算等级。
4. **分类 ↔ 策略**：classifyTask 输出 intent 后策略全丢失；plan 不含 model/runtime/budget/tools。
5. **能力声明缺位**：无 ModelCapabilities/RuntimeCapabilities/TaskRequirements 集中声明；模型判断散落（protocolForModel、KNOWN_VISION、POLICIES）。

## V1.2 改造主线（对应 WP2-WP7）

TaskIntent/TaskRequirements → ExecutionPolicyEngine（deterministic-first）→ ExecutionPolicy{model,runtime,reasoningBudget,maxOutputTokens,tools,retry,fallback,timeout,artifactPolicy} → Executor。
