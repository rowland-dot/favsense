"""The private store of post access codes (`.xhs-favorites/source-codes.json`).

A sync imports a signed link for every note it reads; the service keeps the code from each link here, per
note, so a later build can give that card a link that opens the post. The store is private: the builder
reads it, and nothing else may carry a code (not the catalog, a run record, the log or a reply).

Shape, read by `source-links.mjs`:
    {"schema_version": 1, "notes": {"<note id>": {"code", "source", "captured_at", "batch"}}}

Everything here takes plain values and returns plain values; the bridge does the reading and writing.
"""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urlparse


STORE_NAME = "source-codes.json"
SCHEMA_VERSION = 1

NOTE_PATH = re.compile(r"^/(?:explore|discovery/item)/([A-Za-z0-9_-]{1,128})$")
CODE = re.compile(r"[A-Za-z0-9_\-=+/.]{1,2048}")
SOURCE = re.compile(r"[A-Za-z0-9_]{1,40}")


def captures_from_links(links: dict[str, str]) -> dict[str, tuple[str, str]]:
    """note id -> (code, source) for each imported link that carries a well-formed pair.

    A link with no code, two codes, no source or a value outside the expected characters is skipped:
    that note keeps whatever the store already holds and the import goes on.
    """
    captures: dict[str, tuple[str, str]] = {}
    for note_id, link in links.items():
        parsed = urlparse(link)
        match = NOTE_PATH.fullmatch(parsed.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        codes = query.get("xsec_token", [])
        sources = query.get("xsec_source", [])
        if (
            match is None
            or match.group(1) != note_id
            or len(codes) != 1
            or len(sources) != 1
            or CODE.fullmatch(codes[0]) is None
            or SOURCE.fullmatch(sources[0]) is None
        ):
            continue
        captures[note_id] = (codes[0], sources[0])
    return captures


def merged_store(existing_text: str | None, captures: dict[str, tuple[str, str]], batch: str, captured_at: str) -> dict:
    """The store after this capture: a newer capture replaces an older one, other notes stay as they were.

    A store that is missing or cannot be read is started again from this capture alone; the next sync
    fills it, and the builder refuses a malformed file rather than guess.
    """
    notes: dict[str, dict] = {}
    try:
        previous = json.loads(existing_text) if existing_text else None
    except ValueError:
        previous = None
    if (
        isinstance(previous, dict)
        and previous.get("schema_version") == SCHEMA_VERSION
        and isinstance(previous.get("notes"), dict)
    ):
        notes = dict(previous["notes"])
    for note_id, (code, source) in captures.items():
        notes[note_id] = {"code": code, "source": source, "captured_at": captured_at, "batch": batch}
    return {"schema_version": SCHEMA_VERSION, "notes": notes}
