# Stage 1: build the web app. Only web/ is needed here.
FROM node:26-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: runtime. The server uses only Node built-ins, so there is no npm install.
# data/ and env files are never copied: Elasticsearch is the only data store.
FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server/ ./server/
COPY --from=web-build /build/web/dist ./web/dist
USER node
EXPOSE 8080
CMD ["node", "server/index.mjs"]
