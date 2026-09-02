FROM oven/bun:1 AS release
WORKDIR /app
COPY packages/server/dist ./dist
COPY dist ./packages/core/dist
COPY package.json ./packages/core/package.json
COPY packages/server/package.json ./package.json
RUN sed -i \
      -e 's|"@memstack/core": "workspace:\*"|"@memstack/core": "file:./packages/core"|' \
      -e '/"@memstack\/config-env": "workspace:\*"/d' package.json \
    && bun install --production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "dist/index.js"]
