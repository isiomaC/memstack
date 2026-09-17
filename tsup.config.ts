import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  noExternal: ["@memstack/config-env"],
  external: ["better-sqlite3", "ioredis", "postgres", "pg", "mem0ai", "mem0ai/oss", "@getzep/zep-cloud", "@upstash/redis", "@upstash/vector"],
});
