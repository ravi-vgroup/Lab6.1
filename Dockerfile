FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install production deps first so this layer caches across source changes.
# The lockfile includes the SDK's linux-*-musl binaries, which Alpine needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/

# The Agent SDK's Claude Code subprocess writes to $HOME/.claude; run as the
# unprivileged node user, whose home directory is writable.
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
