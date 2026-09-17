#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=${MEMSTACK_MCP_DOCKER_IMAGE:-memstack-mcp-glama-smoke:local}
docker build --file "$root/packages/mcp/Dockerfile" --tag "$image" "$root"

requests='{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0.0"}},"id":1}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_store","arguments":{"content":"Glama Docker smoke"}},"id":2}
{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_retrieve","arguments":{}},"id":3}'

output=$(printf '%s\n' "$requests" | docker run --rm -i -e OPENAI_API_KEY=artifact-smoke "$image")
printf '%s\n' "$output" | grep -q 'Glama Docker smoke'
