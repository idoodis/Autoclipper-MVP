.PHONY: setup clip test


setup:
corepack enable || true
pnpm -v || npm i -g pnpm
pnpm install
python3 -m venv .venv || true
. .venv/bin/activate && pip install -r requirements.txt || true


clip:
pnpm tsx apps/worker/src/clip.ts --vod samples/vod.mp4 --out out


test:
pnpm vitest run
python3 -m unittest discover -s tests -p "test_*.py"
