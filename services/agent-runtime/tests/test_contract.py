from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]


class ContractTests(unittest.TestCase):
    def test_agentscope_version_and_extras_are_pinned(self):
        text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn("agentscope[service,storage-redis,workspace-docker,tools]==2.0.6", text)
        self.assertNotIn("agentscope-runtime", text)

    def test_no_unsafe_runtime_fallback_or_secret_forwarding(self):
        text = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn("RedisMessageBus", text)
        self.assertIn("DockerWorkspaceManager", text)
        self.assertIn("IsolationPolicy.PER_AGENT", text)
        self.assertIn("env={}", text)
        self.assertNotIn("LocalWorkspaceManager", text)
        self.assertNotIn("InMemoryMessageBus", text)
        self.assertNotIn("API_KEY", text)

    def test_health_contract_does_not_expose_configuration(self):
        text = (ROOT / "main.py").read_text(encoding="utf-8")
        health = text[text.index('"/go-ai/health"') :]
        for forbidden in ("redis_host", "redis_password", "workspace_root", "download_secret"):
            self.assertNotIn(forbidden, health)
