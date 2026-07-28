#!/usr/bin/env python3

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Download an offline faster-whisper model once.")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model_dir = Path(args.model_dir).resolve()
    model_dir.mkdir(parents=True, exist_ok=True)
    WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=str(model_dir),
        local_files_only=False,
    )
    print(f"Offline transcription model '{args.model}' is ready.")


if __name__ == "__main__":
    main()
