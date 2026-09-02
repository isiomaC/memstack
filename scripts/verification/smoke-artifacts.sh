#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/memstack-artifacts.XXXXXX")
server_pid=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$temporary_dir/server.log" ]; then
    cat "$temporary_dir/server.log" >&2
  fi
  rm -rf "$temporary_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$project_root"

node --input-type=module -e 'const core = await import("./dist/index.js"); if (typeof core.MemStack !== "function") process.exit(1)'
node --input-type=commonjs -e 'const core = require("./dist/index.cjs"); if (typeof core.MemStack !== "function") process.exit(1)'

export MEMSTACK_STORAGE=disk
export MEMSTACK_DIR="$temporary_dir/cli"
export MEMSTACK_EMBED_ON_STORE=false
export OPENAI_API_KEY=artifact-smoke

node packages/cli/dist/cli.js store --actor artifact-test --content "CLI artifact smoke" > "$temporary_dir/cli-store.json"
node packages/cli/dist/cli.js retrieve --actor artifact-test > "$temporary_dir/cli-retrieve.json"
node packages/cli/dist/cli.js stats --actor artifact-test > "$temporary_dir/cli-stats.json"
node -e 'const fs = require("node:fs"); const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!rows.some((row) => row.content === "CLI artifact smoke")) process.exit(1)' "$temporary_dir/cli-retrieve.json"

printf '%s\n' \
  '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"artifact-smoke","version":"1.0.0"}},"id":1}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","method":"tools/list","id":2}' |
  node packages/mcp/dist/cli.js > "$temporary_dir/mcp.jsonl"
node -e 'const fs = require("node:fs"); const messages = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse); const result = messages.find((message) => message.id === 2); if (result?.result?.tools?.length !== 18) process.exit(1)' "$temporary_dir/mcp.jsonl"

export PORT=5568
export MEMSTACK_DIR="$temporary_dir/server"
node packages/server/dist/serve.js > "$temporary_dir/server.log" 2>&1 &
server_pid=$!

for attempt in $(seq 1 30); do
  if curl --silent --fail "http://127.0.0.1:$PORT/health" > "$temporary_dir/health.json"; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    exit 1
  fi
  if [ "$attempt" -eq 30 ]; then
    exit 1
  fi
  sleep 1
done

curl --silent --fail --request POST "http://127.0.0.1:$PORT/v1/memories" \
  --header "Content-Type: application/json" \
  --data '{"actorId":"artifact-test","content":"server artifact smoke"}' > "$temporary_dir/server-store.json"
curl --silent --fail --request POST "http://127.0.0.1:$PORT/v1/memories/retrieve" \
  --header "Content-Type: application/json" \
  --data '{"actorId":"artifact-test"}' > "$temporary_dir/server-retrieve.json"
curl --silent --fail "http://127.0.0.1:$PORT/v1/memories/count?actorId=artifact-test" > "$temporary_dir/server-count.json"
node -e 'const fs = require("node:fs"); const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const count = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); if (!rows.some((row) => row.content === "server artifact smoke") || count.count !== 1) process.exit(1)' "$temporary_dir/server-retrieve.json" "$temporary_dir/server-count.json"
