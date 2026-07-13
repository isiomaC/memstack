FROM oven/bun:1 AS release
WORKDIR /app
COPY packages/server/dist ./dist
COPY dist ./packages/core/dist
COPY package.json ./packages/core/package.json
COPY packages/config-env/dist ./packages/config-env/dist
COPY packages/config-env/package.json ./packages/config-env/package.json
COPY packages/server/package.json ./package.json
RUN sed -i \
      -e 's|"@memstack/core": "workspace:\*"|"@memstack/core": "file:./packages/core"|' \
      -e 's|"@memstack/config-env": "workspace:\*"|"@memstack/config-env": "file:./packages/config-env"|' \
      package.json \
    && sed -i 's|"@memstack/core": "workspace:\*"|"@memstack/core": "file:../core"|' packages/config-env/package.json \
    && bun install --production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "dist/index.js"]
