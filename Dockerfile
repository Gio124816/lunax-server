# Explicit Dockerfile — bypasses the Nixpacks/Railpack builder-detection ambiguity
# Railway has been switching between entirely. Railway auto-detects this file and
# prioritizes it over both, so this becomes the single source of truth for the build.

FROM node:20-bookworm-slim

# System dependencies:
# - python3 + build-essential: required to compile better-sqlite3's native addon
#   during `npm install` (this was previously handled transparently by Nix's toolchain)
# - ffmpeg: RTMP restreaming / video processing
# - curl: used elsewhere in the app
# - python3-pip: to install yt-dlp directly from PyPI, kept current rather than
#   pinned to a stale distro/nix snapshot
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Debian's system pip enforces PEP 668 (externally-managed-environment) — this flag
# is required here, unlike the Nix python environment we were fighting with before.
RUN pip3 install --break-system-packages --upgrade yt-dlp

WORKDIR /app

# Copy manifest first so `npm install` is cached as its own layer, separate from
# app code changes — avoids reinstalling node_modules on every code edit.
COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
