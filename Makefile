.PHONY: setup clip test


setup:
corepack enable || true
pnpm -v || npm i -g pnpm
pnpm install
python3 -m venv .venv || true
. .venv/bin/activate && pip install -r requirements.txt || true


clip: samples/vod.mp4
\tpnpm tsx apps/worker/src/clip.ts --vod samples/vod.mp4 --out out

samples/vod.mp4:
\tpnpm tsx scripts/create_sample.ts


test:
pnpm vitest run
