#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=${MEMSTACK_MCP_DOCKER_IMAGE:-memstack-mcp-glama-smoke:local}
postgres_image=pgvector/pgvector@sha256:be400b50812ab2cc908ed78593fda2e51e3b45fe774fa637f1c7b16e68531d95
redis_image=redis/redis-stack-server@sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a
network="memstack-mcp-smoke-$$"
postgres_name="memstack-mcp-smoke-postgres-$$"
redis_name="memstack-mcp-smoke-redis-$$"
sqlite_volume="memstack-mcp-smoke-sqlite-$$"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$postgres_name" "$redis_name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$sqlite_volume" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

if [ "${MEMSTACK_DOCKER_SKIP_BUILD:-false}" != "true" ]; then
  docker build --file "$root/packages/mcp/Dockerfile" --tag "$image" "$root"
fi

# Run one MCP session with a single tool call; extra arguments go to docker run.
mcp_call() {
  tool=$1
  arguments=$2
  shift 2
  requests='{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0.0"}},"id":1}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"'"$tool"'","arguments":'"$arguments"'},"id":2}'

  # The server must exit by itself once stdin closes; timeout exits 124 if it hangs.
  printf '%s\n' "$requests" | docker run --rm -i -e OPENAI_API_KEY=artifact-smoke "$@" "$image" \
    timeout 60 ./node_modules/.bin/memstack-mcp
}

# Store in one process and retrieve in a second, so the memory must persist.
round_trip() {
  label=$1
  shift
  content="Glama Docker smoke $label"
  output=$(mcp_call memory_store '{"content":"'"$content"'"}' "$@")
  output+=$'\n'$(mcp_call memory_retrieve '{}' "$@")
  # Stdout carries only JSON-RPC, and both the store and retrieve responses contain the memory.
  if printf '%s\n' "$output" | grep -qv '^{"' \
    || printf '%s\n' "$output" | grep -q '"isError":true' \
    || [ "$(printf '%s\n' "$output" | grep -c "$content")" -lt 2 ]; then
    printf 'MCP Docker smoke failed for %s:\n%s\n' "$label" "$output" >&2
    exit 1
  fi
  echo "MCP Docker smoke passed: $label"
}

wait_ready() {
  container=$1
  shift
  for attempt in $(seq 1 60); do
    if docker exec "$container" "$@" >/dev/null 2>&1; then return 0; fi
    if [ "$attempt" -eq 60 ]; then
      docker logs "$container" >&2 || true
      exit 1
    fi
    sleep 1
  done
}

round_trip sqlite --volume "$sqlite_volume:/data"

docker network create "$network" >/dev/null
docker run --detach --name "$postgres_name" --network "$network" \
  --env POSTGRES_USER=memstack --env POSTGRES_PASSWORD=memstack --env POSTGRES_DB=memstack \
  "$postgres_image" >/dev/null
docker run --detach --name "$redis_name" --network "$network" "$redis_image" >/dev/null
wait_ready "$postgres_name" psql -U memstack -d memstack -c "SELECT 1"
wait_ready "$redis_name" redis-cli ping

round_trip postgres --network "$network" \
  -e MEMSTACK_STORAGE=postgres \
  -e DATABASE_URL="postgres://memstack:memstack@$postgres_name:5432/memstack"
round_trip redis --network "$network" \
  -e MEMSTACK_STORAGE=redis \
  -e REDIS_URL="redis://$redis_name:6379"
