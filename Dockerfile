# ApiStorm: REST client, load tester, scheduler and callback receiver (no npm dependencies)
FROM node:22-alpine

ENV NODE_ENV=production \
    APISTORM_DOCKER=1 \
    APISTORM_HOST=0.0.0.0 \
    APISTORM_PORT=7070 \
    APISTORM_CB_HOST=0.0.0.0 \
    APISTORM_CB_PORT=7071 \
    APISTORM_DATA=/data

WORKDIR /app
COPY package.json cli.js ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

# 7070 web UI + API, 7071 callback receiver, 7100-7110 extra callback listeners and mock servers
EXPOSE 7070 7071 7100-7110

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${APISTORM_PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/cli.js"]
CMD ["serve"]
