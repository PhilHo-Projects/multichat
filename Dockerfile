# Build the web UI. Coolify clones the repo and builds from here, and webui/dist is
# gitignored, so the image has to produce it rather than expect it in the context.
FROM node:24-alpine AS webui
WORKDIR /app/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci
COPY webui/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/
COPY --from=webui /app/webui/dist ./webui/dist

# PHILCHAT_DB_PATH defaults to /data/philchat.sqlite; /data is a bind mount from
# /home/phil/app-data/philchat, matching every other stateful app on the box.
ENV NODE_ENV=production PORT=8791 HOST=0.0.0.0
EXPOSE 8791

CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
