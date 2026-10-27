# Build from the repo root: docker build -f apps/worker/Dockerfile .
# Also runs database migrations (docker compose `migrate`). No build step: Node runs the
# TypeScript sources directly.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --chown=node:node . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi
USER node
CMD ["node", "apps/worker/src/main.ts"]
