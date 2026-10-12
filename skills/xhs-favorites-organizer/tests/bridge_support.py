"""Shared test support for the sync service (`Bridge`).

`make_bridge` builds a real, fully initialised `Bridge` inside a test's own temporary folder, the same
way production starts it, so no test has to build half an object and hand-set the attributes it needs.
`ScriptRunnerDouble` is the test implementation of the helper-script runner: it returns the results a
test presets and records every command and standard input it was given.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

SKILL_DIR = Path(__file__).parents[1]
BRIDGE_PORT = 47631
BRIDGE_TOKEN = "a" * 64
INSTALL_CAPABILITY = "b" * 64
PROFILE_URL = "https://www.xiaohongshu.com/user/profile/testprofile"


def completed(stdout: str = "", returncode: int = 0, stderr: str = ""):
    """What a finished helper script looks like to the sync service."""
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class ScriptRunnerDouble:
    """Runs no script. Answers each call from what the test preset and keeps the calls for assertions.

    `respond` is either a ready result, a list of results used one per call, or a function taking the
    same arguments as the real runner. A result that is an exception is raised, the way the real runner
    raises on a timeout or an output overflow. With nothing preset, any call is a test failure.
    """

    def __init__(self, respond=None) -> None:
        self.respond = respond
        self.calls: list[SimpleNamespace] = []

    def run(
        self,
        command,
        *,
        input_text,
        cwd,
        env,
        timeout,
        stdout_limit,
        stderr_limit,
        cancelled=None,
    ):
        call = SimpleNamespace(
            command=list(command),
            input_text=input_text,
            cwd=cwd,
            env=env,
            timeout=timeout,
            stdout_limit=stdout_limit,
            stderr_limit=stderr_limit,
            cancelled=cancelled,
        )
        self.calls.append(call)
        respond = self.respond
        if respond is None:
            raise AssertionError(f"no result was preset for the helper script call: {call.command}")
        if callable(respond):
            result = respond(
                call.command,
                input_text=input_text,
                cwd=cwd,
                env=env,
                timeout=timeout,
                stdout_limit=stdout_limit,
                stderr_limit=stderr_limit,
                cancelled=cancelled,
            )
        elif isinstance(respond, list):
            if len(self.calls) > len(respond):
                raise AssertionError(f"more helper script calls than presets: {call.command}")
            result = respond[len(self.calls) - 1]
        else:
            result = respond
        if isinstance(result, BaseException):
            raise result
        return result


def _write_if_absent(path: Path, text: str) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def prepare_workspace(root: Path, config: dict | None = None) -> tuple[Path, Path]:
    """Lay out everything a real start needs inside `root`. Returns (config path, SOP browser runtime).

    `config` is merged over a minimal valid configuration (one enabled board, called "board") and
    written. Without it, a configuration already in `root` is kept, which is what a restart finds.
    """
    state_dir = root / ".xhs-favorites"
    state_dir.mkdir(parents=True, exist_ok=True)
    _write_if_absent(state_dir / "bridge-token", BRIDGE_TOKEN)
    _write_if_absent(state_dir / "userscript-install-capability", INSTALL_CAPABILITY)
    issued_at = datetime.now(timezone.utc)
    _write_if_absent(state_dir / "userscript-install.json", json.dumps({
        "version": 1,
        "digest": hashlib.sha256(INSTALL_CAPABILITY.encode("ascii")).hexdigest(),
        "issued_at": issued_at.isoformat(),
        "expires_at": (issued_at + timedelta(minutes=10)).isoformat(),
    }))
    _write_if_absent(root / ".xhs-tools" / "XHS-Downloader" / ".venv" / "Scripts" / "python.exe", "")
    sop_runtime = root / ".sop-runtime"
    (sop_runtime / ".secrets" / "browser-profiles" / "cdp-chrome").mkdir(parents=True, exist_ok=True)
    (sop_runtime / "scripts").mkdir(parents=True, exist_ok=True)
    _write_if_absent(sop_runtime / ".secrets" / "cdp-port.txt", "9222")
    _write_if_absent(sop_runtime / "scripts" / "启动扫描浏览器.bat", "")
    _write_if_absent(root / "curation.json", "{}")
    _write_if_absent(root / "profile.json", json.dumps({"features": {}}))
    config_path = root / "config.json"
    if config is not None or not config_path.exists():
        config_path.write_text(json.dumps({
            "version": 1,
            "profile_url": PROFILE_URL,
            "boards": [{"id": "board", "name": "Board", "enabled": True, "advertised_count": 1}],
            "curation_file": "curation.json",
            "domain_profile": "profile.json",
            **(config or {}),
        }), encoding="utf-8")
    return config_path, sop_runtime


def make_bridge(module, root: Path, *, script_runner=None, config: dict | None = None):
    """A real `Bridge` started the way production starts it, with the test runner by default."""
    config_path, sop_runtime = prepare_workspace(root, config)
    return module.Bridge(
        root,
        SKILL_DIR,
        config_path,
        sop_runtime,
        BRIDGE_PORT,
        script_runner=script_runner if script_runner is not None else ScriptRunnerDouble(),
    )


def started_bridge(test, module, **options):
    """`make_bridge` in a fresh temporary folder that is removed when `test` ends."""
    directory = tempfile.TemporaryDirectory()
    test.addCleanup(directory.cleanup)
    return make_bridge(module, Path(directory.name), **options)
