#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=${MEMSTACK_DOCKER_IMAGE:-memstack-server-smoke:local}
container_name="memstack-server-smoke-$$"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/memstack-docker.XXXXXX")
artifact_dir=${VERIFICATION_ARTIFACT_DIR:-}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && docker inspect "$container_name" >/dev/null 2>&1; then
    docker logs "$container_name" > "$temporary_dir/container.log" 2>&1 || true
  fi
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ -n "$artifact_dir" ]; then
    mkdir -p "$artifact_dir"
    cp "$temporary_dir/container.log" "$artifact_dir/container.log" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$temporary_dir/container.log" ]; then cat "$temporary_dir/container.log" >&2; fi
  rm -rf "$temporary_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$project_root"
if [ "${MEMSTACK_DOCKER_SKIP_BUILD:-false}" != "true" ]; then
  docker build --file packages/server/Dockerfile --tag "$image" .
fi

docker run --detach --name "$container_name" \
  --env OPENAI_API_KEY=artifact-smoke \
  --env MEMSTACK_STORAGE=disk \
  --env MEMSTACK_EMBED_ON_STORE=false \
  --publish 127.0.0.1::3000 \
  "$image" >/dev/null

port=$(docker port "$container_name" 3000/tcp | sed 's/.*://')
for attempt in $(seq 1 30); do
  if curl --silent --fail "http://127.0.0.1:$port/health" > "$temporary_dir/health.json"; then break; fi
  if ! docker inspect "$container_name" --format '{{.State.Running}}' | grep -q true; then exit 1; fi
  if [ "$attempt" -eq 30 ]; then exit 1; fi
  sleep 1
done

curl --silent --fail --request POST "http://127.0.0.1:$port/v1/memories" \
  --header "Content-Type: application/json" \
  --data '{"actorId":"docker-test","content":"Docker image smoke"}' > "$temporary_dir/store.json"
curl --silent --fail --request POST "http://127.0.0.1:$port/v1/memories/retrieve" \
  --header "Content-Type: application/json" \
  --data '{"actorId":"docker-test"}' > "$temporary_dir/retrieve.json"
node -e 'const fs = require("node:fs"); const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!rows.some((row) => row.content === "Docker image smoke")) process.exit(1)' "$temporary_dir/retrieve.json"
