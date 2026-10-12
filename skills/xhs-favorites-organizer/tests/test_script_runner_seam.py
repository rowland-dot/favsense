"""The sync service runs every helper script through one replaceable script runner.

The runner is handed in when the service starts. Production passes nothing and gets the real,
output-bounded one; a test hands in a double that answers from presets and records what it was asked
to run. These tests start a real, fully initialised service and watch it only through that seam and
through its public operations.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from bridge_support import ScriptRunnerDouble, completed, make_bridge

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_script_runner_seam", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

KNOWN_ID = "a" * 24
NEW_ID = "b" * 24
REVISION = "c" * 64


def url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}"


def known_catalog(bridge) -> None:
    BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
        KNOWN_ID: {
            "note_id": KNOWN_ID, "comment_evidence_checked": True, "content_sha256": REVISION,
        },
    }})


class ImportThroughTheRunnerTests(unittest.TestCase):
    def test_an_import_runs_the_detail_fetch_and_the_organizer_through_the_runner(self):
        fetched_note = {"note_id": NEW_ID, "detail_fetched": True, "comment_evidence_checked": True}

        def respond(command, **_options):
            if "fetch-xhs-details.py" in " ".join(command):
                return completed(json.dumps({"notes": [fetched_note], "failures": []}))
            self.assertIn("organize.mjs", " ".join(command))
            catalog = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
            catalog["notes"][NEW_ID] = {**fetched_note, "content_sha256": REVISION}
            BRIDGE.atomic_json(bridge.catalog_path, catalog)
            return completed()

        with tempfile.TemporaryDirectory() as directory:
            runner = ScriptRunnerDouble(respond)
            bridge = make_bridge(BRIDGE, Path(directory), script_runner=runner)
            known_catalog(bridge)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "run_board_ids": ["board"],
            })

            bridge.process_import("manual_board", "board", {KNOWN_ID: url(KNOWN_ID), NEW_ID: url(NEW_ID)})

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            fetch, organize = runner.calls
            self.assertEqual(fetch.input_text, url(NEW_ID))
            self.assertIn("--max-items", fetch.command)
            self.assertEqual(Path(organize.command[1]).name, "organize.mjs")
            self.assertEqual(json.loads(organize.input_text), {"notes": [fetched_note]})
            self.assertEqual(organize.cwd, bridge.workspace)
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["note_ids"], sorted([KNOWN_ID, NEW_ID]))


if __name__ == "__main__":
    unittest.main()
