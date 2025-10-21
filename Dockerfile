FROM node:20-bullseye-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json requirements.txt ./
RUN npm install
RUN pip3 install --no-cache-dir -r requirements.txt || true

COPY . .

ENV NODE_ENV=production

CMD ["node", "apps/api/server.mjs"]
