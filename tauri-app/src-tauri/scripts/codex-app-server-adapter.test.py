from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).with_name("codex-app-server-adapter.py")


def load_adapter_module():
    spec = importlib.util.spec_from_file_location("codex_app_server_adapter", SCRIPT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CodexBinResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.adapter = load_adapter_module()

    def test_resolves_codex_from_nvm_when_app_path_is_limited(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)
            codex_bin = home / ".nvm" / "versions" / "node" / "v22.22.1" / "bin" / "codex"
            codex_bin.parent.mkdir(parents=True)
            codex_bin.write_text("#!/bin/sh\n", encoding="utf-8")

            with patch.dict(
                os.environ,
                {"HOME": str(home), "PATH": "/usr/bin:/bin"},
                clear=False,
            ):
                os.environ.pop("CODEX_BIN", None)

                self.assertEqual(self.adapter._resolve_codex_bin(), str(codex_bin))

    def test_codex_bin_env_takes_precedence(self) -> None:
        with patch.dict(
            os.environ,
            {"CODEX_BIN": " /custom/codex ", "PATH": "/usr/bin:/bin"},
            clear=False,
        ):
            self.assertEqual(self.adapter._resolve_codex_bin(), "/custom/codex")


if __name__ == "__main__":
    unittest.main()
