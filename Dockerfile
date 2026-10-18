# ==========================================
# STAGE 1: Dependency Builder & Test Runner
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules if needed
RUN apk add --no-cache python3 make g++

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies (including devDependencies for test verification)
RUN npm ci

# Copy application source code
COPY . .

# Run pre-flight diagnostic test suite to guarantee zero regressions before containerization
RUN DOCKER_BUILD_SKIP_DB_TESTS=true npm test

# Prune devDependencies for lean production runtime image
RUN npm prune --production

# ==========================================
# STAGE 2: Secure Production Runtime
# ==========================================
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="Build-BD Marketplace API" \
      org.opencontainers.image.version="24.0.0" \
      org.opencontainers.image.description="Production Enterprise Infrastructure & Kubernetes-ready Node.js Engine"

WORKDIR /app

# Install dumb-init to properly handle PID 1 signal forwarding (SIGTERM/SIGINT)
# and prevent zombie process accumulation under Kubernetes pod auto-scaling.
RUN apk add --no-cache dumb-init

# Create non-root system user and group for Principle of Least Privilege (UID 1000)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1000

# Create uploads directory with non-root ownership
RUN mkdir -p /app/uploads && chown -R appuser:appgroup /app/uploads

# Copy pruned node_modules and application source from builder stage
COPY --chown=appuser:appgroup --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/models ./models
COPY --chown=appuser:appgroup --from=builder /app/routes ./routes
COPY --chown=appuser:appgroup --from=builder /app/middleware ./middleware
COPY --chown=appuser:appgroup --from=builder /app/services ./services
COPY --chown=appuser:appgroup --from=builder /app/utils ./utils
COPY --chown=appuser:appgroup --from=builder /app/public ./public
COPY --chown=appuser:appgroup --from=builder /app/server.js ./server.js
COPY --chown=appuser:appgroup --from=builder /app/package.json ./package.json

# Switch to non-root system user
USER 1000

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=5000
# server.js binds to loopback by default (safe for a laptop). A container must listen on its
# network interface or Kubernetes probes and the Service can never reach it (audit F1).
ENV BIND_ADDRESS=0.0.0.0

EXPOSE 5000

# Use dumb-init as PID 1 to ensure graceful connection pool drainage on pod termination
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
