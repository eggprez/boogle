# Boogle's Reddit worker: Playwright's image (Ubuntu + Node + Chromium) plus
# worker.mjs. The playwright-core package version must match the image tag,
# because the browsers baked into the image are the ones that version drives.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY worker.mjs ./

# /data: the result cache and the persistent browser profile (cookies), so a
# restart does not start from a cold, more suspicious-looking browser.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "worker.mjs"]
