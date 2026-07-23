#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=${E2E_ARTIFACT_DIR:-"$project_root/artifacts/e2e"}
services=(postgres redis qdrant neo4j weaviate mongodb)

mkdir -p "$artifact_dir"
cd "$project_root"

export PG_PORT=${PG_PORT:-5433}
export REDIS_PORT=${REDIS_PORT:-6380}
export QDRANT_PORT=${QDRANT_PORT:-6333}
export QDRANT_VECTOR_SIZE=${QDRANT_VECTOR_SIZE:-16}
export QDRANT_COLLECTION=${QDRANT_COLLECTION:-memstack-e2e}
export NEO4J_URI=${NEO4J_URI:-bolt://localhost:7687}
export NEO4J_USER=${NEO4J_USER:-neo4j}
export NEO4J_PASSWORD=${NEO4J_PASSWORD:-memstack123}
export WEAVIATE_HOST=${WEAVIATE_HOST:-localhost}
export WEAVIATE_PORT=${WEAVIATE_PORT:-8080}
export WEAVIATE_GRPC_PORT=${WEAVIATE_GRPC_PORT:-50051}
export WEAVIATE_CLASS=${WEAVIATE_CLASS:-MemstackE2E}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose logs --no-color > "$artifact_dir/services.log" 2>&1 || true
  fi
  docker compose down -v > "$artifact_dir/cleanup.log" 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

docker compose up -d --wait "${services[@]}"
pnpm test:e2e -- --reporter=verbose 2>&1 | tee "$artifact_dir/vitest.log"
