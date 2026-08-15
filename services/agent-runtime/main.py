"""Internal AgentScope service for Go AI project workspaces."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Mapping

# 运行时诊断：模型调用/工具执行 traceback 输出到 stdout（容器日志）
logging.basicConfig(level=os.environ.get("AGENTSCOPE_LOG", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@dataclass(frozen=True)
class Settings:
    redis_host: str
    redis_port: int
    redis_db: int
    redis_password: str | None
    workspace_root: str
    sandbox_image: str
    download_secret: str


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    values = os.environ if env is None else env

    def required(name: str) -> str:
        value = values.get(name, "").strip()
        if not value:
            raise RuntimeError(f"{name} is required")
        return value

    redis_host = required("REDIS_HOST")
    workspace_root = required("AGENTSCOPE_WORKSPACE_ROOT")
    secret = required("AGENTSCOPE_DOWNLOAD_SECRET")
    if len(secret.encode("utf-8")) < 32:
        raise RuntimeError("AGENTSCOPE_DOWNLOAD_SECRET must be at least 32 bytes")

    return Settings(
        redis_host=redis_host,
        redis_port=int(values.get("REDIS_PORT", "6379")),
        redis_db=int(values.get("REDIS_DB", "0")),
        redis_password=values.get("REDIS_PASSWORD") or None,
        workspace_root=workspace_root,
        sandbox_image=values.get("AGENTSCOPE_SANDBOX_IMAGE", "python:3.11-slim"),
        download_secret=secret,
    )


def create_go_ai_app(settings: Settings):
    from agentscope import __version__ as agentscope_version
    from agentscope.app import create_app
    from agentscope.app.message_bus import RedisMessageBus
    from agentscope.app.storage import RedisStorage
    from agentscope.app.workspace_manager import (
        DockerWorkspaceManager,
        IsolationPolicy,
        LocalWorkspaceManager,
    )

    redis_options = {
        "host": settings.redis_host,
        "port": settings.redis_port,
        "db": settings.redis_db,
        "password": settings.redis_password,
    }
    # AGENTSCOPE_SANDBOX=local 时用 LocalWorkspaceManager（宿主机目录沙盒，无嵌套容器）；
    # 默认 Docker 沙盒（嵌套容器隔离）。Docker 模式若遇工具/schema 兼容问题可切换 local。
    sandbox = os.environ.get("AGENTSCOPE_SANDBOX", "docker")
    workspace_manager = (
        LocalWorkspaceManager(
            basedir=settings.workspace_root,
            isolation=IsolationPolicy.PER_AGENT,
            ttl=3600,
        )
        if sandbox == "local"
        else DockerWorkspaceManager(
            basedir=settings.workspace_root,
            isolation=IsolationPolicy.PER_AGENT,
            base_image=settings.sandbox_image,
            node_version="20",
            env={},
            ttl=3600,
            sweep_interval=300,
        )
    )
    app = create_app(
        storage=RedisStorage(**redis_options),
        message_bus=RedisMessageBus(**redis_options),
        workspace_manager=workspace_manager,
        download_secret=settings.download_secret,
        title="Go AI Agent Runtime",
    )

    @app.get("/go-ai/health", tags=["go-ai"])
    async def go_ai_health() -> dict[str, object]:
        return {
            "ok": True,
            "agentscopeVersion": agentscope_version,
            "storage": "redis",
            "messageBus": "redis",
            "workspace": sandbox,
            "isolation": "per_agent",
        }

    return app


app = create_go_ai_app(load_settings())
