# Container image for the always-on market maker (ELO-10).
#
#   docker build -f deploy/Dockerfile -t proof-mm .
#   docker run --rm --env-file .env --restart=unless-stopped \
#     -v "$PWD/data:/app/data" proof-mm
#
# --restart=unless-stopped gives crash auto-restart; the mounted ./data volume
# persists the nonce high-water mark, control file, and crash-recovery journal
# across restarts. The HOST must be NTP-synced (engine uses timestamp nonces);
# containers inherit the host clock.
FROM node:22-slim

WORKDIR /app

# Install root deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Vendored SDK (git submodule) + source.
COPY vendor/ ./vendor/
RUN npm run setup
COPY . .

# Non-root runtime user.
RUN useradd -m proofmm && chown -R proofmm /app
USER proofmm

# SIGINT → bot.ts flattens quotes before exit.
STOPSIGNAL SIGINT
CMD ["npm", "run", "bot", "--", "1"]
