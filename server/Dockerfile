# ---- Node.js build stage (server + shared) ----
FROM node:24-alpine AS builder
WORKDIR /app

# The build stage only compiles TypeScript: no need for Playwright's browser
# download (playwright-chromium postinstall). The production stage installs it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
COPY shared/ ./shared/
RUN cd shared && npm install && npm run build

COPY server/package.json ./server/
RUN cd server && npm install

COPY server/tsconfig.json server/knexfile.ts ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# ---- Production stage ----
# Debian (glibc), NOT Alpine: Playwright's Chromium is a glibc build and
# cannot run on musl, so Browser monitors need a Debian-based image
# (same recipe as proxy/Dockerfile).
FROM node:24-bookworm-slim AS production
WORKDIR /app

# openssh-client: SSH remediations. iputils-ping: Ping monitors (shell out to
# `ping`, which the slim image does not ship). ca-certificates: TLS checks.
# wget, curl, netcat, dnsutils, iproute2, procps and busybox (+ /bin/ash) keep
# Script monitors and script remediations (/custom scripts, `#!/bin/ash`)
# working as they did on the previous Alpine image. Note: /bin/sh is now dash.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-client iputils-ping ca-certificates \
        wget curl netcat-openbsd dnsutils iproute2 procps busybox && \
    ln -sf /bin/busybox /bin/ash && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/

COPY --from=builder /app/server/package.json ./server/
COPY package.json ./
RUN cd server && npm install --omit=dev

# Playwright system dependencies + Chromium for Browser monitors.
# Run from server/ so `npx playwright` resolves to the locally installed
# playwright-chromium CLI: the downloaded browser revision then matches the
# library version exactly.
RUN cd server && \
    npx playwright install-deps chromium && \
    npx playwright install chromium && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/server/dist/ ./server/dist/

# Agent installer scripts + VERSION file (used by GET /api/agent/version)
COPY agent/installer/ ./agent/installer/
COPY agent/VERSION ./agent/

# All agent binaries are built and code-signed locally (Windows, Linux, macOS).
# The release pipeline builds Windows + MSI locally, then cross-compiles
# Linux/macOS via SSH on remote hosts. All outputs land in agent/dist/.
RUN mkdir -p ./agent/dist
COPY agent/dist/ ./agent/dist/

# Obli.tools VERSION file (read by GET /api/agent/desktop-version to drive the update banner).
COPY obli.tools/VERSION ./obli.tools/

# Obli.tools release binaries (build on Windows/macOS locally).
RUN mkdir -p ./obli.tools/dist
COPY obli.tools/dist/ ./obli.tools/dist/

COPY server/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

# The slim image has neither wget nor curl: probe /health with Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

WORKDIR /app/server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
