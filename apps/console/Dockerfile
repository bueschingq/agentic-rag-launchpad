# Build from the repo root: docker build -f apps/console/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
RUN npm run build --workspace @launchpad/console

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/console/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=node:node /repo/apps/console/public ./apps/console/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/console/server.js"]
