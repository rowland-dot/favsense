"""Branch coverage for the platform access permission module.

The permission module is the only place that answers "may we touch the platform now?".
Every case below feeds it a different record on disk and checks the answer it gives.
"""

import importlib.util
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "platform_access.py"
SPEC = importlib.util.spec_from_file_location("favsense_platform_access_test", MODULE_PATH)
ACCESS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ACCESS)

STOP_NAME = "media-download-safety-stop.json"
# Noon UTC: the same calendar day in every inhabited time zone up to UTC+11.
STOPPED_AT = "2026-08-29T12:00:00+00:00"
ROUND_AFTER = "2026-10-12T09:00:00+00:00"
ROUND_BEFORE = "2026-08-01T09:00:00+00:00"


def write_record(state_dir: Path, value, name: str = STOP_NAME) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / name
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


class ReadStopTests(unittest.TestCase):
    def test_no_record_means_the_platform_may_be_contacted(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            self.assertIsNone(ACCESS.read_stop(state_dir))
            self.assertIsNone(ACCESS.legacy_stop(state_dir, None))

    def test_a_record_in_the_old_format_is_read_as_a_stop_from_media_or_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "reason": "platform-safety-limit"})
            stop = ACCESS.read_stop(state_dir)
            self.assertEqual(stop["phase"], "media_or_detail")
            self.assertEqual(stop["phase_label"], "媒体或详情")
            self.assertEqual(stop["date"], "2026-08-29")
            # With no round running, any record is a leftover from an earlier round.
            self.assertEqual(ACCESS.legacy_stop(state_dir, None)["phase"], "media_or_detail")

    def test_a_record_that_names_its_phase_keeps_it(self):
        labels = {
            "detail": "详情抓取", "media": "媒体下载", "page": "页面", "diandian": "点点总结",
        }
        for phase, label in labels.items():
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                state_dir = Path(directory)
                write_record(state_dir, {
                    "stopped_at": STOPPED_AT, "reason": "platform-safety-limit", "phase": phase,
                })
                stop = ACCESS.read_stop(state_dir)
                self.assertEqual((stop["phase"], stop["phase_label"]), (phase, label))

    def test_an_unrecognised_phase_is_read_as_unknown_not_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "<script>"})
            stop = ACCESS.read_stop(state_dir)
            self.assertEqual((stop["phase"], stop["phase_label"]), ("unknown", "未知"))

    def test_a_corrupt_record_still_counts_as_a_stop_with_an_unknown_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            path = state_dir / STOP_NAME
            state_dir.mkdir(parents=True, exist_ok=True)
            path.write_text("{not json", encoding="utf-8")
            stop = ACCESS.read_stop(state_dir)
            self.assertIsNotNone(stop)
            self.assertEqual(stop["phase"], "unknown")
            self.assertIsNotNone(ACCESS.legacy_stop(state_dir, None))

    def test_a_record_that_is_not_a_plain_file_still_counts_as_a_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            (state_dir / STOP_NAME).mkdir(parents=True)
            stop = ACCESS.read_stop(state_dir)
            self.assertIsNotNone(stop)
            self.assertEqual(stop["phase"], "unknown")

    def test_a_renamed_archive_is_not_a_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(
                state_dir,
                {"stopped_at": STOPPED_AT, "reason": "platform-safety-limit"},
                name="media-download-safety-stop.archived-20260829.json",
            )
            self.assertIsNone(ACCESS.read_stop(state_dir))
            self.assertIsNone(ACCESS.legacy_stop(state_dir, None))


class RoundClassificationTests(unittest.TestCase):
    def test_a_record_written_after_the_round_began_belongs_to_that_round(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {
                "stopped_at": "2026-10-12T09:30:00+00:00", "phase": "media",
            })
            self.assertIsNone(ACCESS.legacy_stop(state_dir, ROUND_AFTER))
            self.assertTrue(ACCESS.stop_in_round(state_dir, ROUND_AFTER))

    def test_a_record_older_than_the_round_is_a_leftover_even_while_it_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "media"})
            self.assertIsNotNone(ACCESS.legacy_stop(state_dir, ROUND_AFTER))
            self.assertFalse(ACCESS.stop_in_round(state_dir, ROUND_AFTER))

    def test_a_record_with_no_readable_time_is_never_mistaken_for_this_round(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"reason": "platform-safety-limit"})
            self.assertIsNotNone(ACCESS.legacy_stop(state_dir, ROUND_AFTER))
            self.assertFalse(ACCESS.stop_in_round(state_dir, ROUND_AFTER))

    def test_no_round_means_nothing_belongs_to_a_round(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "media"})
            self.assertFalse(ACCESS.stop_in_round(state_dir, None))

    def test_a_round_start_that_cannot_be_read_counts_as_no_round(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "media"})
            self.assertIsNotNone(ACCESS.legacy_stop(state_dir, "not a time"))
            self.assertFalse(ACCESS.stop_in_round(state_dir, "not a time"))


class WriteStopTests(unittest.TestCase):
    def test_a_stop_is_recorded_once_with_its_time_and_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory) / "state"
            path = ACCESS.stop_path(state_dir)
            self.assertEqual(path.name, STOP_NAME)
            self.assertTrue(ACCESS.write_stop(path, "detail"))
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["phase"], "detail")
            self.assertEqual(saved["reason"], "platform-safety-limit")
            self.assertEqual(datetime.fromisoformat(saved["stopped_at"]).utcoffset().total_seconds(), 0)
            # The record keeps the first moment the platform said stop; a later stop does not rewrite it.
            self.assertFalse(ACCESS.write_stop(path, "media"))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["phase"], "detail")

    def test_a_stop_can_be_recorded_at_an_explicit_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = ACCESS.stop_path(Path(directory))
            moment = datetime(2026, 10, 12, 9, 30, tzinfo=timezone.utc)
            self.assertTrue(ACCESS.write_stop(path, "page", now=moment))
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8"))["stopped_at"], moment.isoformat()
            )

    def test_an_unknown_phase_cannot_be_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = ACCESS.stop_path(Path(directory))
            with self.assertRaises(ValueError):
                ACCESS.write_stop(path, "somewhere-else")
            self.assertFalse(path.exists())

    def test_a_missing_path_records_nothing(self):
        self.assertFalse(ACCESS.write_stop(None, "detail"))


class ClearStopTests(unittest.TestCase):
    def test_clearing_archives_the_record_with_its_content_and_its_date(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            original = {"stopped_at": STOPPED_AT, "reason": "platform-safety-limit"}
            write_record(state_dir, original)
            cleared = ACCESS.clear_stop(state_dir)
            self.assertEqual(cleared["date"], "2026-08-29")
            self.assertFalse((state_dir / STOP_NAME).exists())
            archived = state_dir / "media-download-safety-stop.archived-20260829.json"
            self.assertEqual(json.loads(archived.read_text(encoding="utf-8")), original)
            self.assertIsNone(ACCESS.read_stop(state_dir))

    def test_clearing_with_no_record_does_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            self.assertIsNone(ACCESS.clear_stop(state_dir))
            self.assertEqual(list(state_dir.iterdir()), [])

    def test_a_second_archive_on_the_same_date_never_overwrites_the_first(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "media"})
            ACCESS.clear_stop(state_dir)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "page"})
            ACCESS.clear_stop(state_dir)
            archives = sorted(path.name for path in state_dir.iterdir())
            self.assertEqual(len(archives), 2, archives)
            phases = sorted(
                json.loads((state_dir / name).read_text(encoding="utf-8"))["phase"]
                for name in archives
            )
            self.assertEqual(phases, ["media", "page"])

    def test_an_unreadable_record_is_archived_under_todays_date(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            (state_dir / STOP_NAME).write_text("{not json", encoding="utf-8")
            # A date that is not today, so ignoring the supplied time would be noticed.
            clock = datetime(2031, 3, 4, 8, 0, tzinfo=timezone.utc)
            cleared = ACCESS.clear_stop(state_dir, now=clock)
            self.assertIsNone(cleared["date"])
            self.assertTrue(
                (state_dir / "media-download-safety-stop.archived-20310304.json").is_file()
            )


class PublicViewTests(unittest.TestCase):
    def test_the_public_view_carries_only_the_date_and_the_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {
                "stopped_at": STOPPED_AT, "phase": "diandian", "reason": "platform-safety-limit",
            })
            view = ACCESS.public_view(ACCESS.read_stop(state_dir))
            self.assertEqual(
                view,
                {"date": "2026-08-29", "phase": "diandian", "phase_label": "点点总结"},
            )

    def test_the_refusal_names_the_date_and_how_to_clear_it(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            write_record(state_dir, {"stopped_at": STOPPED_AT, "phase": "media"})
            message = ACCESS.legacy_message(ACCESS.read_stop(state_dir))
            self.assertIn("2026-08-29", message)
            self.assertIn("尚未清除", message)

    def test_the_refusal_for_an_unreadable_record_does_not_invent_a_date(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            (state_dir / STOP_NAME).write_text("{not json", encoding="utf-8")
            message = ACCESS.legacy_message(ACCESS.read_stop(state_dir))
            self.assertIn("尚未清除", message)
            self.assertNotRegex(message, r"\d{4}-\d{2}-\d{2}")


SCRIPTS = MODULE_PATH.parent
CASES = json.loads(
    (Path(__file__).parents[1] / "test-fixtures" / "safety-signal-cases.json").read_text(encoding="utf-8")
)
REQUIRED_EXAMPLES = (
    "这个工具可以自动识别验证码",
    "HTTP/1.1 429 Too Many Requests",
    "访问频繁，请稍后再试",
    '{"code": 300031}',
)
NODE = shutil.which("node")


def cases_in(context: str):
    return [case for case in CASES["cases"] if case["context"] == context]


class SafetySignalTableTests(unittest.TestCase):
    """The shared table that every copy of the block-recognition rule is held to."""

    def test_the_table_is_well_formed(self):
        identifiers = [case["id"] for case in CASES["cases"]]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        for case in CASES["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(set(case), {"id", "context", "text", "blocked", "why"})
                self.assertIn(case["context"], CASES["contexts"])
                self.assertIsInstance(case["blocked"], bool)
                self.assertTrue(case["why"].strip())
        for context in CASES["contexts"]:
            answers = {case["blocked"] for case in cases_in(context)}
            self.assertEqual(answers, {True, False}, f"{context} needs a blocking and a non-blocking case")

    def test_the_table_carries_the_known_disagreements_with_a_reason_for_each_context(self):
        for text in REQUIRED_EXAMPLES:
            contexts = {case["context"] for case in CASES["cases"] if case["text"] == text}
            self.assertGreaterEqual(len(contexts), 2, text)
        # The same sentence is a block when a request returned no note and ordinary content on a page.
        by_context = {
            case["context"]: case["blocked"]
            for case in CASES["cases"] if case["text"] == "这个工具可以自动识别验证码"
        }
        self.assertIs(by_context["failure-output"], True)
        self.assertIs(by_context["page-shell"], False)

    def test_the_python_rule_for_failed_requests_follows_the_table(self):
        for case in cases_in("failure-output"):
            with self.subTest(case=case["id"]):
                self.assertEqual(bool(ACCESS.SAFETY_SIGNAL.search(case["text"])), case["blocked"], case["why"])

    def test_the_python_rule_for_requests_that_returned_a_note_follows_the_table(self):
        for case in cases_in("diagnostic-output"):
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    bool(ACCESS.STRUCTURED_SAFETY_SIGNAL.search(case["text"])), case["blocked"], case["why"]
                )

    @unittest.skipUnless(NODE, "the injected page check is JavaScript and is run with node")
    def test_the_page_check_the_bridge_injects_follows_the_table(self):
        contexts = ("dialog-text", "page-script")
        cases = [case for context in contexts for case in cases_in(context)]
        driver = """
          const snippet = process.argv[1];
          const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
          const answers = cases.map(({ context, text }) => {
            const visible = (element) => element.visible !== false;
            const document = {
              querySelectorAll(selector) {
                if (selector.includes('role="alert"')) return context === "dialog-text" ? [{ innerText: text, textContent: text }] : [];
                if (selector.includes("application/json")) return context === "page-script" ? [{ textContent: text }] : [];
                return [];
              }
            };
            const run = new Function("document", "visible", snippet + " return { safety: false };");
            return run(document, visible).safety === true;
          });
          process.stdout.write(JSON.stringify(answers));
        """
        completed = subprocess.run(
            [NODE, "-e", driver, ACCESS.injected_page_check_js()],
            input=json.dumps(cases), capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        answers = json.loads(completed.stdout)
        for case, answer in zip(cases, answers, strict=True):
            with self.subTest(case=case["id"]):
                self.assertEqual(answer, case["blocked"], case["why"])

    def test_the_block_rule_is_defined_in_exactly_one_python_file(self):
        offenders = [
            path.name for path in sorted(SCRIPTS.glob("*.py"))
            if path.name != MODULE_PATH.name and "300031" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual(offenders, [])
        self.assertIn("300031", MODULE_PATH.read_text(encoding="utf-8"))

    def test_the_scripts_that_consult_the_rule_share_the_modules_own_objects(self):
        for name in ("fetch-xhs-details.py", "download-pending-media.py", "bridge-server.py"):
            spec = importlib.util.spec_from_file_location(f"consumer_{name.replace('-', '_')}", SCRIPTS / name)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with self.subTest(script=name):
                rule = getattr(module, "SAFETY_SIGNAL", None) or getattr(module, "SAFETY_LIMIT", None) \
                    or getattr(module, "PLATFORM_SAFETY_SIGNAL")
                self.assertEqual(rule.pattern, ACCESS.SAFETY_SIGNAL.pattern)
                self.assertEqual(rule.flags, ACCESS.SAFETY_SIGNAL.flags)


if __name__ == "__main__":
    unittest.main()
