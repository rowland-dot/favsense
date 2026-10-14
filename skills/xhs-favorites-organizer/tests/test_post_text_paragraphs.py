"""AC-PARA: the detail cleanup keeps the post's line breaks (spec CAP-06)."""

import importlib.util
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).parents[1] / "scripts"
NOTE_ID = "a" * 24


def load_fetcher():
    spec = importlib.util.spec_from_file_location("xhs_fetcher_paragraphs", SCRIPTS / "fetch-xhs-details.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


FETCHER = load_fetcher()


def description_of(raw_text):
    return FETCHER.normalize({"作品描述": raw_text}, NOTE_ID)["description"]


class PostTextParagraphs(unittest.TestCase):
    def test_paragraph_breaks_survive_and_spaces_are_tidied_per_line(self):
        self.assertEqual(description_of("第一段  有空格\n\n第二段\n第三行"), "第一段 有空格\n\n第二段\n第三行")

    def test_windows_and_old_mac_line_endings_become_newlines(self):
        self.assertEqual(description_of("甲\r\n乙\r丙"), "甲\n乙\n丙")

    def test_three_or_more_newlines_become_one_blank_line(self):
        self.assertEqual(description_of("甲\n\n\n\n乙"), "甲\n\n乙")

    def test_leading_and_trailing_blank_lines_are_dropped(self):
        self.assertEqual(description_of("\n\n甲\n乙\n\n"), "甲\n乙")

    def test_an_empty_description_stays_none(self):
        self.assertIsNone(description_of("  \n \n"))

    def test_the_twenty_thousand_character_limit_still_applies(self):
        self.assertEqual(len(description_of("字" * 25_000)), 20_000)

    def test_the_title_and_other_single_line_fields_stay_on_one_line(self):
        result = FETCHER.normalize({"作品标题": "标题\n 第二行", "作者昵称": "作者\n名"}, NOTE_ID)
        self.assertEqual(result["title"], "标题 第二行")
        self.assertEqual(result["author"], "作者 名")


if __name__ == "__main__":
    unittest.main()
