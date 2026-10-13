#!/usr/bin/env python3
"""Take and release the DianDian private store lock over and over.

Run by tests/test_save_summary.py, several copies at once, to prove that
writers handing the lock to each other never fail and never wait long.
Prints one JSON line: cycles done, the failures seen (type and message), and
the longest time any single acquisition waited.

Usage: lock_stress_worker.py <save_diandian_summary.py> <private root> <cycles> <hold seconds>
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

MAX_RECORDED_FAILURES = 5


def main() -> None:
    script, private_root, cycles, hold_seconds = sys.argv[1:5]
    spec = importlib.util.spec_from_file_location("save_diandian_summary_worker", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    done = 0
    failures: list[str] = []
    failure_count = 0
    longest_wait = 0.0
    for _ in range(int(cycles)):
        started = time.monotonic()
        try:
            with module.private_store_lock(Path(private_root)):
                longest_wait = max(longest_wait, time.monotonic() - started)
                time.sleep(float(hold_seconds))
            done += 1
        except Exception as error:  # Every kind of failure is the evidence.
            failure_count += 1
            longest_wait = max(longest_wait, time.monotonic() - started)
            if len(failures) < MAX_RECORDED_FAILURES:
                cause = f" <- {type(error.__cause__).__name__}: {error.__cause__}" if error.__cause__ else ""
                failures.append(f"{type(error).__name__}: {error}{cause}")
    print(json.dumps({
        "cycles_done": done,
        "failure_count": failure_count,
        "failures": failures,
        "longest_wait_seconds": longest_wait,
    }))


if __name__ == "__main__":
    main()
