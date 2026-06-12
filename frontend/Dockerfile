# =============================================================================
# Stage 1 — Build the React SPA
# =============================================================================
FROM node:24-alpine AS builder

WORKDIR /workspace

# Copy root workspace manifest so npm can resolve the workspace protocol
COPY package.json package-lock.json ./

# Copy the shared-ui package (peer dep of frontend)
COPY shared-ui/ shared-ui/

# Copy the frontend package
COPY frontend/package.json    frontend/package.json
COPY frontend/tsconfig.json   frontend/tsconfig.json
COPY frontend/vite.config.ts  frontend/vite.config.ts
COPY frontend/index.html      frontend/index.html
COPY frontend/src/            frontend/src/

# Install all workspace dependencies from the lockfile
RUN npm ci --workspace=frontend --include-workspace-root

# Build — API_URL can be passed at image build time via --build-arg
ARG API_URL=""
ENV API_URL=${API_URL}

WORKDIR /workspace/frontend
RUN npm run build

# =============================================================================
# Stage 2 — Serve with Nginx
# =============================================================================
FROM nginx:1.28-alpine AS runtime

# Remove the default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy compiled assets
COPY --from=builder /workspace/frontend/dist /usr/share/nginx/html

# Copy our nginx config template (uses envsubst variables)
COPY frontend/nginx.conf /etc/nginx/nginx.conf.template

# envsubst replaces ${API_URL} at container start.
# We expose only port 80; TLS termination happens at CloudFront.
EXPOSE 80

# Boot: substitute env vars in the nginx config then launch nginx
CMD ["/bin/sh", "-c", \
     "envsubst '${API_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && nginx -g 'daemon off;'"]
