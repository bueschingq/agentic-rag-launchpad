# Build from the repo root: docker build -f apps/sniffer/Dockerfile .
FROM node:24-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PORT=4100
WORKDIR /repo
COPY --chown=node:node . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright
USER node
EXPOSE 4100
CMD ["node", "apps/sniffer/src/main.ts"]
