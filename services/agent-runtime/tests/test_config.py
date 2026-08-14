import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).parents[1] / "main.py"


def load_module_without_app_line():
    source = MODULE_PATH.read_text(encoding="utf-8")
    source = source.replace("\napp = create_go_ai_app(load_settings())\n", "\n")
    spec = importlib.util.spec_from_loader("runtime_config", loader=None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile(source, str(MODULE_PATH), "exec"), module.__dict__)
    return module


def valid_env():
    return {
        "REDIS_HOST": "redis",
        "AGENTSCOPE_WORKSPACE_ROOT": "/data/workspaces",
        "AGENTSCOPE_DOWNLOAD_SECRET": "x" * 32,
    }


class SettingsTests(unittest.TestCase):
    def test_required_configuration_is_fail_closed(self):
        module = load_module_without_app_line()
        with self.assertRaisesRegex(RuntimeError, "REDIS_HOST"):
            module.load_settings({})

    def test_download_secret_requires_32_bytes(self):
        module = load_module_without_app_line()
        env = valid_env()
        env["AGENTSCOPE_DOWNLOAD_SECRET"] = "too-short"
        with self.assertRaisesRegex(RuntimeError, "32 bytes"):
            module.load_settings(env)

    def test_defaults_are_pinned_to_docker_runtime(self):
        module = load_module_without_app_line()
        settings = module.load_settings(valid_env())
        self.assertEqual(settings.redis_port, 6379)
        self.assertEqual(settings.redis_db, 0)
        self.assertEqual(settings.sandbox_image, "python:3.11-slim")
