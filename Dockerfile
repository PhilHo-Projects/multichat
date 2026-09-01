FROM node:24-alpine
WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8791 HOST=0.0.0.0
EXPOSE 8791
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
