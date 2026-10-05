FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data

USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
