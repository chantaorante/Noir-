# syntax=docker/dockerfile:1.7
# ---------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @noir/engine build && pnpm --filter @noir/shared build \
 && pnpm --filter @noir/server build && pnpm --filter @noir/web build \
 && pnpm --filter @noir/server deploy --prod --legacy /out/server

# ---------- runtime stage (no build tools, non-root)
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 noir && useradd --system --uid 10001 --gid noir --no-create-home noir
COPY --from=build --chown=root:root /out/server /app/apps/server
COPY --from=build --chown=root:root /src/apps/web/dist /app/web
COPY --chown=root:root db/migrations /app/db/migrations
ENV MIGRATIONS_DIR=/app/db/migrations STATIC_DIR=/app/web
USER noir
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/apps/server/dist/main.js"]
