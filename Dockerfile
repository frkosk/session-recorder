FROM node:22-bookworm-slim

# build nástroje kvôli natívnej kompilácii better-sqlite3 (potrebné aj na ARM64/RPi5)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js viewer.html recorder.js ./

# /data je perzistentný volume — vytvor a odovzdaj user 'node'
RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
