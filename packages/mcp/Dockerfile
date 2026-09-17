FROM node:22-bookworm-slim

WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src ./src
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json tsup.config.ts ./
RUN pnpm install --frozen-lockfile && pnpm build:all \
  && mkdir /runtime \
  && pnpm pack --pack-destination /tmp/tarballs \
  && pnpm --dir packages/mcp pack --pack-destination /tmp/tarballs \
  && cd /runtime \
  && npm init -y \
  && npm install /tmp/tarballs/memstack-core-*.tgz /tmp/tarballs/memstack-mcp-*.tgz better-sqlite3@^11.10.0

WORKDIR /runtime
RUN mkdir /data
ENV MEMSTACK_STORAGE=sqlite SQLITE_PATH=/data/memstack.db MEMSTACK_EMBED_ON_STORE=false
CMD ["./node_modules/.bin/memstack-mcp"]
