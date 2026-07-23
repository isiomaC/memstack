#!/usr/bin/env bash
set -Eeuo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/memstack-packages.XXXXXX")
pack_dir="$temporary_dir/tarballs"
consumer_dir="$temporary_dir/consumer"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  rm -rf "$temporary_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$pack_dir" "$consumer_dir"
cd "$project_root"

node scripts/verification/check-versions.mjs
pnpm pack --pack-destination "$pack_dir"
pnpm --dir packages/cli pack --pack-destination "$pack_dir"
pnpm --dir packages/mcp pack --pack-destination "$pack_dir"
pnpm --dir packages/server pack --pack-destination "$pack_dir"

for archive in "$pack_dir"/*.tgz; do
  tar -tf "$archive" > "$archive.contents"
  grep -q '^package/package.json$' "$archive.contents"
  grep -q '^package/dist/' "$archive.contents"
done

node --input-type=module - "$consumer_dir/package.json" <<'NODE'
import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], JSON.stringify({ name: "memstack-package-smoke", version: "1.0.0", private: true, type: "module" }));
NODE

cd "$consumer_dir"
pnpm add "$pack_dir"/memstack-core-*.tgz
pnpm add "$pack_dir"/memstack-cli-*.tgz "$pack_dir"/memstack-mcp-*.tgz "$pack_dir"/memstack-server-*.tgz

node --input-type=module -e 'const core = await import("@memstack/core"); if (typeof core.MemStack !== "function") process.exit(1)'
node --input-type=commonjs -e 'const core = require("@memstack/core"); if (typeof core.MemStack !== "function") process.exit(1)'
node --input-type=module -e 'await import("@memstack/mcp")'
node --input-type=module -e 'await import("@memstack/server")'
node --input-type=module - <<'NODE'
import { readFile, access } from "node:fs/promises";
const checks = [
  ["@memstack/core", "dist/index.d.ts"],
  ["@memstack/cli", "dist/cli.d.ts", "dist/cli.js"],
  ["@memstack/mcp", "dist/index.d.ts", "dist/cli.js"],
  ["@memstack/server", "dist/index.d.ts", "dist/serve.js"],
];
for (const [name, ...files] of checks) {
  const entryUrl = import.meta.resolve(name);
  const manifestUrl = new URL("../package.json", entryUrl);
  const manifest = JSON.parse(await readFile(new URL(manifestUrl), "utf8"));
  if (manifest.dependencies?.["@memstack/config-env"]) process.exit(1);
  const packageUrl = new URL("./", manifestUrl);
  for (const file of files) await access(new URL(file, packageUrl));
}
NODE

test -x node_modules/.bin/memstack
test -x node_modules/.bin/memstack-mcp
test -x node_modules/.bin/memstack-server
