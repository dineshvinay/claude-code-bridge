#!/usr/bin/env python3
"""Local Whisper transcription for hubos-bridge (universal, $0, offline).

Reads an audio file path (argv[1] or $NEXUS_AUDIO), prints the transcript to
stdout. Uses faster-whisper (CTranslate2) on CPU int8 — small + fast, downloads
the model once then runs offline. Model is configurable via HUBOS_WHISPER_MODEL
(default "base"; try "small" for better accuracy).

Setup (one-time):  pip install faster-whisper
"""
import os
import sys

try:
    from faster_whisper import WhisperModel
except Exception:
    sys.stderr.write("faster-whisper not installed. Run: pip install faster-whisper\n")
    sys.exit(2)

audio = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NEXUS_AUDIO", "")
if not audio or not os.path.exists(audio):
    sys.stderr.write("audio file not found\n")
    sys.exit(3)

model_name = os.environ.get("HUBOS_WHISPER_MODEL", "base")
try:
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(audio, vad_filter=True)
    print("".join(seg.text for seg in segments).strip())
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"transcription error: {exc}\n")
    sys.exit(4)
