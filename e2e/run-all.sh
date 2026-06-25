#!/bin/bash
set -e
echo "=== MemStack E2E Test Suite ==="

export PG_PORT=5433 REDIS_PORT=6380 QDRANT_PORT=6333 QDRANT_VECTOR_SIZE=16 QDRANT_COLLECTION=memstack-e2e
export NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=memstack123
export WEAVIATE_HOST=localhost WEAVIATE_PORT=8080 WEAVIATE_GRPC_PORT=50051 WEAVIATE_CLASS=MemstackE2E

docker compose -f docker-compose.yml up -d postgres redis qdrant neo4j weaviate mongodb 2>&1 | tail -3

echo "Waiting for Docker services..."
until docker exec memstack-postgres-1 pg_isready -U memstack 2>/dev/null; do sleep 1; done
until docker exec memstack-redis-1 redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
until curl -sf http://localhost:6333/healthz 2>/dev/null; do sleep 1; done
until docker exec memstack-neo4j-1 cypher-shell -u neo4j -p memstack123 'RETURN 1' 2>/dev/null | grep -q "1"; do sleep 1; done
until curl -sf http://localhost:8080/v1/meta 2>/dev/null > /dev/null; do sleep 1; done
until docker exec memstack-mongodb-1 mongosh --eval "db.runCommand('ping').ok" 2>/dev/null | grep -q "1"; do sleep 1; done
echo "All Docker services ready."

RESULTS=()
run_test() {
  echo ""
  echo "--- $1 ---"
  if npx vitest run --config vitest.e2e.config.ts --reporter verbose 2>&1 | grep -q "^✓ $2\|Tests.*0 failed"; then
    RESULTS+=("$1: PASS")
  else
    RESULTS+=("$1: FAIL")
  fi
}

echo ""
echo "--- Docker-backed adapters ---"
run_test "Postgres (Docker)" e2e/postgres.e2e.ts
run_test "Redis (Docker)" e2e/redis.e2e.ts
run_test "Qdrant (Docker)" e2e/qdrant.e2e.ts
run_test "Neo4j (Docker)" e2e/neo4j.e2e.ts
run_test "Weaviate (Docker)" e2e/weaviate.e2e.ts
run_test "MongoDB (Docker)" e2e/mongodb.e2e.ts

echo ""
echo "--- Local adapters (no Docker) ---"
npx tsx e2e/lancedb.e2e.ts 2>&1 | tail -3
npx tsx e2e/sqlite.e2e.ts 2>&1 | tail -3
npx tsx e2e/chroma.e2e.ts 2>&1 | tail -3

echo ""
echo "=== E2E Results ==="
for r in "${RESULTS[@]}"; do echo "  $r"; done

docker compose -f docker-compose.yml down 2>/dev/null
echo "E2E suite complete."
