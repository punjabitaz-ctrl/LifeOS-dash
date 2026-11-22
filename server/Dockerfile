# LifeOS sync service. No dependencies to install: the service uses Node built-ins only.
# Build from the repository root:  docker build -f server/Dockerfile -t lifeos-sync .
FROM node:22-alpine
ENV NODE_ENV=production \
    LIFEOS_CONFIG_DIR=/config \
    LIFEOS_DATA_DIR=/data \
    LIFEOS_HOST=0.0.0.0 \
    LIFEOS_PORT=8787 \
    LIFEOS_TRUST_PROXY=1
WORKDIR /app
COPY server/index.mjs ./index.mjs
COPY server/lib ./lib
RUN mkdir -p /config /data && chown -R node:node /config /data /app
USER node
VOLUME ["/config", "/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD node -e "const n=require('node:net').connect(8787,'127.0.0.1');n.on('connect',()=>process.exit(0));n.on('error',()=>process.exit(1))"
CMD ["node", "index.mjs"]
