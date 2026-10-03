FROM node:22-slim AS builder

RUN npm install -g pnpm@latest

WORKDIR /app

COPY naxionai/pnpm-workspace.yaml naxionai/package.json naxionai/pnpm-lock.yaml ./
COPY naxionai/theia/packages/app/package.json theia/packages/app/
COPY naxionai/theia/packages/agent-views/package.json theia/packages/agent-views/
COPY naxionai/server/package.json server/

RUN pnpm install --frozen-lockfile || pnpm install

COPY naxionai/theia theia
COPY naxionai/server server

RUN cd theia && pnpm -r build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/theia theia
COPY --from=builder /app/server server

ENV NODE_ENV=production
ENV THEIA_PORT=7472

EXPOSE 7472

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://127.0.0.1:7472 || exit 1

CMD ["sh", "-c", "cd theia/packages/app && npx theia start --port 7472 --hostname 0.0.0.0"]
