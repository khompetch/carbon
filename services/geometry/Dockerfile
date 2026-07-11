# syntax=docker/dockerfile:1

# --- Python dependencies -----------------------------------------------------
FROM python:3.12-slim-bookworm AS python-deps
WORKDIR /build
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir --prefix=/opt/python .

# --- Node tooling (gltf-transform for the meshopt compression pass) ----------
FROM node:20-bookworm-slim AS node-tools
RUN npm install -g @gltf-transform/cli@4.4.0

# --- Runtime ------------------------------------------------------------------
FROM python:3.12-slim-bookworm

# Shared libs required by the OCCT (cadquery-ocp) wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglu1-mesa libxrender1 libxext6 libsm6 libice6 libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Node 20 runtime + gltf-transform CLI (same Debian base, glibc-compatible).
COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=node-tools /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/@gltf-transform/cli/bin/cli.js /usr/local/bin/gltf-transform

COPY --from=python-deps /opt/python /usr/local

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
