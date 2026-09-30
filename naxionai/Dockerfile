# NeuroWorks server + web console.
# Builds the SPA, then runs the tsx server with SERVE_WEB=1 so one container
# serves both the API and the console. Matches the image name referenced by
# k8s/03-primary.yaml (neuroworks:latest).
#
# Build:  docker build -t neuroworks:latest .
# Run:    docker run -p 7471:7471 --env-file .env neuroworks:latest

# ── Stage 1: build the web SPA ──────────────────────────────────────────
FROM node:22-slim AS web-build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY web/ web/
RUN pnpm -F neuroworks-web build

# ── Stage 2: runtime ────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
RUN corepack enable
# Playwright chromium deps (browser.js PDF/render path). Skip the browser
# download itself unless RENDER_BROWSER=1 build-arg is passed.
ARG RENDER_BROWSER=0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
      $(if [ "$RENDER_BROWSER" = "1" ]; then echo "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2"; fi) \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm store prune

COPY server/ server/
COPY --from=web-build /app/web/dist web/dist/

ENV NODE_ENV=production \
    NEUROWORKS_PORT=7471 \
    SERVE_WEB=1 \
    # Wide bind inside the container is expected; put a TLS proxy in front
    # or set NEUROWORKS_ENTERPRISE_MODE=1 for cross-host peers.
    NEUROWORKS_BIND_HOST=0.0.0.0 \
    NEUROWORKS_ALLOW_INSECURE_BIND=1
EXPOSE 7471

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEUROWORKS_PORT||7471)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "-F", "neuroworks-server", "start"]
