FROM node:24-slim

# Install Playwright system dependencies + Chromium
RUN npx playwright install-deps chromium && \
    npx playwright install chromium

# Install ping utility for ping checks
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy compiled JS (build before Docker build: npx tsc)
COPY dist/ ./dist/

ENV NODE_ENV=production

# Device identity (/data/device-uuid) must survive container re-creation;
# mount a named volume here (e.g. -v obliview-proxy-data:/data) or set DEVICE_UUID.
VOLUME ["/data"]

ENTRYPOINT ["node", "dist/index.js"]
