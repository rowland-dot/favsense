"""Issue 106: the sync service keeps the access code of every post a sync imports, in one private file.

The code comes in on each imported link. It is kept in `.xhs-favorites/source-codes.json` and nowhere
else: not in the catalog, the run record, the manual-sync record or the service log. The codes below
are made up.
"""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import bridge_support
from bridge_support import completed


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_source_codes", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

NOTE_A = "6a7dc92600000000250090ff"
NOTE_B = "6a7dc92600000000250090aa"
NOTE_C = "6a7dc92600000000250090bb"
BATCH = "manual20261010"


def signed(note_id, code, source="pc_collect"):
    return f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token={code}&xsec_source={source}"


def started(root, *, batch=BATCH):
    """A real service whose helper scripts are doubles, with a manual run open for the board."""
    bridge = bridge_support.make_bridge(BRIDGE, root)
    bridge.cache_missing_media = mock.Mock(
        return_value={"queued": 0, "downloaded": 0, "safety_stopped": False}
    )
    bridge.tag_catalog_sources = mock.Mock()
    bridge.next_board_id = mock.Mock(return_value="more-boards")
    bridge.publish_after_board = mock.Mock(return_value=None)
    BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {}})
    BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": batch, "state": "running"})
    return bridge


def respond_like_the_helpers(bridge, fetched):
    def respond(command, **options):
        joined = " ".join(command)
        if "fetch-xhs-details.py" in joined:
            return completed(json.dumps({"notes": [
                {"note_id": note_id, "detail_fetched": True, "comment_evidence_checked": True}
                for note_id in fetched
            ], "failures": []}))
        if "organize.mjs" in joined:
            payload = json.loads(options["input_text"])
            existing = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
            existing["notes"].update({note["note_id"]: note for note in payload["notes"]})
            BRIDGE.atomic_json(bridge.catalog_path, existing)
            return completed()
        raise AssertionError(f"unexpected helper script call: {command}")

    bridge.script_runner.respond = respond


def import_links(bridge, urls, *, batch=BATCH):
    # Each call is one board import of a manual round that is still open.
    BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": batch, "state": "running"})
    run_id = bridge.manual_run_id(batch, "board")
    return bridge.import_sync({"run_id": run_id, "board_id": "board", "urls": list(urls)})


def read_store(bridge):
    return json.loads((bridge.state_dir / "source-codes.json").read_text(encoding="utf-8"))


class SourceCodeStoreTests(unittest.TestCase):
    def test_an_import_keeps_each_notes_code_with_its_source_capture_time_and_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A, NOTE_B])
            before = datetime.now(timezone.utc)
            import_links(bridge, [signed(NOTE_A, "FAKEcodeA1=="), signed(NOTE_B, "FAKEcodeB1", "pc_share")])
            after = datetime.now(timezone.utc)

            store = read_store(bridge)
            self.assertEqual(store["schema_version"], 1)
            self.assertEqual(set(store["notes"]), {NOTE_A, NOTE_B})
            first = store["notes"][NOTE_A]
            self.assertEqual((first["code"], first["source"], first["batch"]), ("FAKEcodeA1==", "pc_collect", BATCH))
            self.assertEqual(store["notes"][NOTE_B]["code"], "FAKEcodeB1")
            self.assertEqual(store["notes"][NOTE_B]["source"], "pc_share")
            captured = datetime.fromisoformat(first["captured_at"])
            self.assertTrue(before <= captured <= after, first["captured_at"])

    def test_the_store_is_written_with_the_summary_stage_on_as_well_as_off(self):
        for enabled in (False, True):
            with self.subTest(summaries_enabled=enabled), tempfile.TemporaryDirectory() as directory:
                bridge = started(Path(directory))
                bridge.diandian_enabled = enabled
                respond_like_the_helpers(bridge, [NOTE_A])
                import_links(bridge, [signed(NOTE_A, "FAKEcodeA1")])
                self.assertEqual(read_store(bridge)["notes"][NOTE_A]["code"], "FAKEcodeA1")

    def test_a_newer_capture_replaces_an_older_one_and_leaves_other_notes_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A, NOTE_B])
            import_links(bridge, [signed(NOTE_A, "FAKEcodeOLD"), signed(NOTE_B, "FAKEcodeB1")])
            first_capture = read_store(bridge)["notes"][NOTE_A]["captured_at"]

            # A later round (a new batch) imports note A again with a new code.
            second_batch = "manual20261011"
            import_links(bridge, [signed(NOTE_A, "FAKEcodeNEW", "pc_share")], batch=second_batch)

            notes = read_store(bridge)["notes"]
            self.assertEqual(notes[NOTE_A]["code"], "FAKEcodeNEW")
            self.assertEqual(notes[NOTE_A]["source"], "pc_share")
            self.assertEqual(notes[NOTE_A]["batch"], second_batch)
            self.assertGreaterEqual(notes[NOTE_A]["captured_at"], first_capture)
            self.assertEqual(notes[NOTE_B]["code"], "FAKEcodeB1")
            self.assertEqual(notes[NOTE_B]["batch"], BATCH)

    def test_a_link_with_no_code_keeps_the_code_already_stored_and_a_run_of_plain_links_writes_no_store(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A, NOTE_C])
            import_links(bridge, [f"https://www.xiaohongshu.com/explore/{NOTE_C}"])
            self.assertFalse((bridge.state_dir / "source-codes.json").exists())

            import_links(bridge, [signed(NOTE_A, "FAKEcodeA1")])
            second_batch = "manual20261011"
            import_links(bridge, [f"https://www.xiaohongshu.com/explore/{NOTE_A}"], batch=second_batch)
            self.assertEqual(read_store(bridge)["notes"][NOTE_A]["code"], "FAKEcodeA1")

    def test_a_code_that_is_not_in_the_expected_shape_is_not_kept_and_does_not_stop_the_import(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A, NOTE_B, NOTE_C])
            status, result = import_links(bridge, [
                f"https://www.xiaohongshu.com/discovery/item/{NOTE_A}?xsec_token=has%20space&xsec_source=pc_collect",
                f"https://www.xiaohongshu.com/discovery/item/{NOTE_B}?xsec_token=FAKEcodeB1",
                signed(NOTE_C, "FAKEcodeC1", "bad source!"),
            ])
            self.assertEqual(status, BRIDGE.HTTPStatus.OK, result)
            self.assertFalse((bridge.state_dir / "source-codes.json").exists())

    def test_a_malformed_store_is_replaced_by_this_captures_codes_instead_of_blocking_the_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A])
            (bridge.state_dir / "source-codes.json").write_text("{ broken", encoding="utf-8")
            status, result = import_links(bridge, [signed(NOTE_A, "FAKEcodeA1")])
            self.assertEqual(status, BRIDGE.HTTPStatus.OK, result)
            self.assertEqual(list(read_store(bridge)["notes"]), [NOTE_A])

    def test_no_code_reaches_the_catalog_the_run_records_or_the_service_log(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = started(Path(directory))
            respond_like_the_helpers(bridge, [NOTE_A])
            import_links(bridge, [signed(NOTE_A, "FAKEcodeA1abcdefghijkl")])

            store_path = bridge.state_dir / "source-codes.json"
            self.assertIn("FAKEcodeA1abcdefghijkl", store_path.read_text(encoding="utf-8"))
            checked = 0
            for path in sorted(Path(directory).rglob("*")):
                if not path.is_file() or path == store_path:
                    continue
                try:
                    text = path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):
                    continue
                checked += 1
                self.assertNotIn("FAKEcodeA1abcdefghijkl", text, str(path.relative_to(directory)))
            for name in ("catalog.json", "manual-sync.json", f"runs/{bridge.manual_run_id(BATCH, 'board')}.json"):
                text = (bridge.state_dir / name).read_text(encoding="utf-8")
                self.assertNotIn("xsec_token", text, name)
            self.assertGreater(checked, 3, "the catalog, run record and manual-sync record were not even looked at")


if __name__ == "__main__":
    unittest.main()
