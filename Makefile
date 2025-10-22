.PHONY: setup clip test api worker dashboard


setup:
	npm install


clip: samples/vod.mp4
	npm run clip -- --vod samples/vod.mp4 --out out

samples/vod.mp4:
	node scripts/create_sample.mjs


test:
	npm test


api:
	npm run api


worker:
	npm run worker

dashboard:
	npm run dashboard
