#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$project_root"

pnpm run build
pnpm --filter @memstack/config-env run build
pnpm --filter @memstack/cli run build
pnpm --filter @memstack/mcp run build
pnpm --filter @memstack/server run build
