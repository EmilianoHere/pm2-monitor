# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# pm2-monitor container image. Mode-agnostic (standalone|agent|server) but the
# shipped examples target SERVER (hub) mode. node:20-slim is preferred over
# alpine for pm2 native/glibc reliability.
# ---------------------------------------------------------------------------

# --- Stage 1: build (compile TypeScript -> dist/) ---
FROM node:20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# --- Stage 2: runtime (prod deps only; pm2 stays as a prod dependency) ---
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
RUN mkdir -p /app/config && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
