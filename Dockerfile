# Node >= 24 runs the .ts sources directly (type stripping), so there is no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# All state (SQLite incl. API key and SMTP password) lives in DATA_DIR: mount a volume there.
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]

USER node
EXPOSE 3000

# Run node directly (not "npm start"), so SIGTERM reaches the app and it shuts down cleanly.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
