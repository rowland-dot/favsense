"""Which cached files are the images of a note. One definition, read by the OCR extractor and the sync service.

The media cache holds a single-image note as `<note id>.<ext>` and a multi-image note as one file per
page, `<note id>_<page>.<ext>`.
"""

import re
from pathlib import PurePath

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_IMAGE_NAME = re.compile(r"^(?P<note_id>[a-f0-9]{24})(?:_(?P<page>[0-9]+))?$")


def image_page(file_name: str):
    """(note id, page number) when the file name is a cached note image, otherwise None.

    A file without a page suffix is page 0. Pages order by number, so page 2 comes before page 10.
    """
    path = PurePath(file_name)
    if path.suffix.lower() not in IMAGE_SUFFIXES:
        return None
    match = _IMAGE_NAME.fullmatch(path.stem)
    if not match:
        return None
    return match["note_id"], int(match["page"] or 0)
