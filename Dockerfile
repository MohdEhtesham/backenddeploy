FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Private document storage for the local driver (dev / single-node only;
# use STORAGE_DRIVER=cloudinary in staging / production).
RUN mkdir -p /app/storage/private && chown -R node:node /app/storage

USER node
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "src/server.js"]
