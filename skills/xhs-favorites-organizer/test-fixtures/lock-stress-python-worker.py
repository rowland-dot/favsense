#!/usr/bin/env python3
"""Take and release the DianDian private store lock over and over, from its own process.

Run by tests/organization-lock-handoff.test.mjs next to lock-stress-worker.mjs, to prove that the Python
writer and the JS writers handing the one lock to each other never fail or get stuck.
This is the same loop as the DianDian skill's own lock_stress_worker.py, plus the progress lines the
JS test needs to say who was stuck and on what. Every line on stdout is one JSON object:
  {"event":"cycle","cycle":N}                              one full take-hold-release finished
  {"event":"heartbeat","cycle":N,"phase":P,"phase_ms":T}   every 2 s: what it is doing and for how long
  {"event":"final", ...}                                   cycles done, failures, longest single wait

Usage: lock-stress-python-worker.py <save_diandian_summary.py> <private root> <cycles> <hold seconds>
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
import traceback
from pathlib import Path

MAX_RECORDED_FAILURES = 5
HEARTBEAT_SECONDS = 2.0


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


def main() -> None:
    script, private_root, cycles, hold_seconds = sys.argv[1:5]
    spec = importlib.util.spec_from_file_location("save_diandian_summary_worker", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    state = {"done": 0, "phase": "starting", "since": time.monotonic()}
    stop = threading.Event()

    def enter(phase: str) -> None:
        state["phase"] = phase
        state["since"] = time.monotonic()

    def heartbeat() -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            emit({
                "event": "heartbeat",
                "cycle": state["done"],
                "phase": state["phase"],
                "phase_ms": round((time.monotonic() - state["since"]) * 1000),
            })

    threading.Thread(target=heartbeat, daemon=True).start()

    failures: list[str] = []
    failure_count = 0
    longest_wait = 0.0
    for _ in range(int(cycles)):
        started = time.monotonic()
        enter("acquiring")
        try:
            with module.private_store_lock(Path(private_root)):
                longest_wait = max(longest_wait, time.monotonic() - started)
                enter("holding")
                time.sleep(float(hold_seconds))
                enter("releasing")
            state["done"] += 1
            emit({"event": "cycle", "cycle": state["done"]})
        except Exception as error:  # Every kind of failure is the evidence.
            failure_count += 1
            longest_wait = max(longest_wait, time.monotonic() - started)
            if len(failures) < MAX_RECORDED_FAILURES:
                cause = f" <- {type(error.__cause__).__name__}: {error.__cause__}" if error.__cause__ else ""
                failures.append(f"{type(error).__name__}: {error}{cause}" + chr(10) + traceback.format_exc())
        enter("resting")
    stop.set()
    emit({
        "event": "final",
        "cycles_done": state["done"],
        "failure_count": failure_count,
        "failures": failures,
        "longest_wait_ms": round(longest_wait * 1000),
    })


if __name__ == "__main__":
    main()
