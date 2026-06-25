import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "e2e/postgres.e2e.ts",
      "e2e/redis.e2e.ts",
      "e2e/qdrant.e2e.ts",
      "e2e/neo4j.e2e.ts",
      "e2e/weaviate.e2e.ts",
      "e2e/sqlite.e2e.ts",
      "e2e/chroma.e2e.ts",
      "e2e/lancedb.e2e.ts",
      "e2e/mongodb.e2e.ts",
    ],
  },
});
