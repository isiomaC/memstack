FROM node:22-slim AS build
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-workspace.yaml ./
COPY package.json pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/
RUN pnpm install --frozen-lockfile --prod --filter @memstack/server
COPY dist ./packages/core/dist
COPY packages/server/dist ./packages/server/dist

FROM oven/bun:1 AS release
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "dist/index.js"]
