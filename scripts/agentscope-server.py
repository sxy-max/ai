# AgentScope 2.0 Agent Server（V1.2 WP8 运行时）
#
# 官方结构（agentscope examples/agent_service）：
#   RedisStorage + InMemoryMessageBus + LocalWorkspaceManager(basedir, per_agent) -> create_app -> uvicorn
#
# 共享卷对齐：basedir = WORKSPACES_ROOT（与 devExecutor 同一根），per_agent 隔离下
# 每个 agent 的工作区 = WORKSPACES_ROOT/{agent_id}；AgentScopeRuntimeAdapter 负责
# 把任务 input/working 同步进 agent 工作区、执行后把 output/ 同步回原 workspace。
#
# 启动：python scripts/agentscope-server.py
# 环境：WORKSPACES_ROOT（默认 /data/workspaces；本地可用 D:/Projects/go-ai/.data/agentscope-ws）
#       REDIS_URL（默认 redis://127.0.0.1:16379）——本地测试用现有 goai-redis
#       PORT（默认 8000）

import logging
import os

import uvicorn
from agentscope.app import create_app
from agentscope.app.message_bus import InMemoryMessageBus
from agentscope.app.storage import RedisStorage
from agentscope.app.workspace_manager import IsolationPolicy, LocalWorkspaceManager


def main() -> None:
    logging.basicConfig(level=os.environ.get("AGENTSCOPE_LOG", "INFO"))
    workspaces_root = os.environ.get("WORKSPACES_ROOT", "/data/workspaces")
    redis_host = os.environ.get("REDIS_HOST", "127.0.0.1")
    redis_port = int(os.environ.get("REDIS_PORT", "16379"))
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))

    os.makedirs(workspaces_root, exist_ok=True)

    storage = RedisStorage(host=redis_host, port=redis_port)
    message_bus = InMemoryMessageBus()
    workspace_manager = LocalWorkspaceManager(
        basedir=workspaces_root,
        isolation=IsolationPolicy.PER_AGENT,
        ttl=float(os.environ.get("AGENTSCOPE_WS_TTL", "3600")),
    )

    app = create_app(
        storage=storage,
        message_bus=message_bus,
        workspace_manager=workspace_manager,
        title="Go AI AgentScope Runtime",
    )
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
