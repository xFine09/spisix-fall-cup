FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/spisix.db PORT=3000
COPY package.json config.json server.js ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
