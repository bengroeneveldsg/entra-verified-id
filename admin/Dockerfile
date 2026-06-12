# =============================================================================
# Stage 1: Build React SPA
# Build context: v2/ root (contains shared-ui/ and admin/)
# =============================================================================
FROM node:24-alpine AS web-builder

WORKDIR /workspace

# Copy workspace root manifest + lockfile so npm can resolve the workspace protocol
COPY package.json package-lock.json ./

# Copy shared-ui and admin web source
COPY shared-ui/ shared-ui/
COPY admin/web/package.json    admin/web/package.json
COPY admin/web/tsconfig.json   admin/web/tsconfig.json
COPY admin/web/vite.config.ts  admin/web/vite.config.ts
COPY admin/web/index.html      admin/web/index.html
COPY admin/web/src/            admin/web/src/

# Install workspace deps from root (resolves @entra-vid/shared-ui as a local package)
RUN npm ci --workspace=admin/web --include-workspace-root

WORKDIR /workspace/admin/web
RUN npm run build

# =============================================================================
# Stage 2: Python runtime
# =============================================================================
FROM python:3.13-slim AS runtime

# curl is required for the ECS health check
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --no-create-home --shell /bin/false appuser

WORKDIR /app

COPY admin/pyproject.toml ./
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir .

COPY admin/app/ ./app/

# Built React SPA served by FastAPI at /app/static/
COPY --from=web-builder /workspace/admin/web/dist ./app/static/

USER appuser

EXPOSE 8000

ENV PYTHONPATH=/app

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
