.PHONY: setup clip test


setup:
	npm install


clip: samples/vod.mp4
	node apps/worker/src/clip.mjs --vod samples/vod.mp4 --out out

samples/vod.mp4:
	node scripts/create_sample.mjs


test:
	npm test
