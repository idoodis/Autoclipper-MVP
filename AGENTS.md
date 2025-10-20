# Project
Auto‑Clipper MVP — take a local VOD (`/samples/vod.mp4`), remove deadspace, add captions, render 9:16 clip with watermark.


# Dev Environment
- Node 20 + pnpm
- Python 3.11
- ffmpeg installed and on PATH


# Commands
- make setup # installs deps for Node + Python
- make clip # runs end‑to‑end on sample files into /out
- make test # runs unit tests


# Acceptance Criteria for a "clip"
- <= 59s, 1080x1920 (9:16)
- No silent segments > 1.5s
- Burnt‑in captions (from transcription)
- Watermark in top‑left
- Exports: `/out/clip.mp4`, `/out/captions.srt`, `/out/timeline.json`


# Notes for Codex
- Prefer small, composable modules with tests
- All changes should be runnable via the Makefile targets
- If assets are missing, create tiny mocks
