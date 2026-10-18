FROM oven/bun:1.2@sha256:6ebf306367da43ad75c4d5119563e24de9b66372929ad4fa31546be053a16f74 AS release
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
RUN mkdir -p /app/memstack-data && chown bun:bun /app/memstack-data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "dist/index.js"]
