"""Whether a DianDian reply is a refusal to read the note, not a summary of it.

Now and then DianDian does not open the note. It answers that it cannot reach the link and asks for the
text or a screenshot to be sent back. Such a reply is never a summary: the collection step must not save
it, a saved one must not count as a record, and no later step may use it as evidence or show it.

This is the one Python copy of the rule. The JavaScript copy is diandian-refusal.mjs. Both are tested
against test-fixtures/diandian-refusal-cases.json, which holds real replies.
"""

from __future__ import annotations

import re

# The page wraps bold words in zero-width spaces, so they sit inside real replies.
_INVISIBLE = re.compile("[​‌‍⁠﻿]")

# A refusal says so at the start; a summary that merely contains these words further in is not one.
_LEAD_CHARS = 400

# Form 1: opens with an apology and says "cannot" in that same sentence. This alone identifies a reply
# cut off after its first clause, which names no copy or screenshot request.
_APOLOGY_THEN_CANNOT = re.compile(r"^\s*(?:很)?抱歉[^。！？!?\n]*?无法")

# Form 2: asks for the note's text or a screenshot to be sent back, with or without an apology.
_ASKS_TO_SEND_THE_NOTE = re.compile(r"(?:复制|粘贴|截图|截屏)[^。！？!?\n]{0,30}?(?:发给我|发送给我|发我|贴给我|给我)")


def is_refusal(text: object) -> bool:
    if not isinstance(text, str):
        return False
    lead = _INVISIBLE.sub("", text)[:_LEAD_CHARS]
    return bool(_APOLOGY_THEN_CANNOT.search(lead) or _ASKS_TO_SEND_THE_NOTE.search(lead))
