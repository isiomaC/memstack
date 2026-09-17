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

node --input-type=module - "$consumer_dir/package.json" "$pack_dir"/memstack-core-*.tgz <<'NODE'
import { writeFile } from "node:fs/promises";
await writeFile(process.argv[2], JSON.stringify({
  name: "memstack-package-smoke",
  version: "1.0.0",
  private: true,
  type: "module",
  pnpm: { overrides: { "@memstack/core": `file:${process.argv[3]}` } },
}));
NODE

cd "$consumer_dir"
# Install every locally packed package in one resolution so inter-package
# dependencies (for example, cli -> core) resolve to these release artifacts
# instead of querying npm for a version that has not been published yet.
pnpm add --allow-build=better-sqlite3 "$pack_dir"/*.tgz better-sqlite3@^11.10.0

node --input-type=module -e 'const core = await import("@memstack/core"); if (typeof core.MemStack !== "function") process.exit(1)'
node --input-type=commonjs -e 'const core = require("@memstack/core"); if (typeof core.MemStack !== "function") process.exit(1)'
node --input-type=module -e 'await import("@memstack/mcp")'
node --input-type=module -e 'await import("@memstack/server")'
node --input-type=module - <<'NODE'
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
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
  if (name === "@memstack/mcp") {
    if (manifest.peerDependencies?.["better-sqlite3"] !== "^11.10.0") {
      throw new Error("@memstack/mcp must declare better-sqlite3 as a peer dependency");
    }
    if (manifest.peerDependenciesMeta?.["better-sqlite3"]?.optional !== true) {
      throw new Error("@memstack/mcp must make better-sqlite3 an optional peer");
    }
    const cli = await readFile(new URL("dist/cli.js", packageUrl), "utf8");
    if (!/import\((['"])better-sqlite3\1\)/.test(cli)) {
      throw new Error("@memstack/mcp must leave better-sqlite3 as a runtime import");
    }
    createRequire(new URL("dist/cli.js", packageUrl)).resolve("better-sqlite3");
  }
}
NODE

test -x node_modules/.bin/memstack
test -x node_modules/.bin/memstack-mcp
test -x node_modules/.bin/memstack-server

sqlite_path="$temporary_dir/memstack-mcp.sqlite"
node --input-type=module - "$sqlite_path" <<'NODE'
import { spawn } from "node:child_process";

const child = spawn("./node_modules/.bin/memstack-mcp", [], {
  env: { ...process.env, MEMSTACK_STORAGE: "sqlite", SQLITE_PATH: process.argv[2], MEMSTACK_EMBED_ON_STORE: "false", OPENAI_API_KEY: "package-smoke" },
  stdio: ["pipe", "pipe", "pipe"],
});
const requests = [
  { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package-smoke", version: "1.0.0" } }, id: 1 },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", method: "tools/call", params: { name: "memory_store", arguments: { content: "SQLite package smoke" } }, id: 2 },
  { jsonrpc: "2.0", method: "tools/call", params: { name: "memory_retrieve", arguments: {} }, id: 3 },
];
const retrieved = await new Promise((resolve, reject) => {
  let output = "";
  let stderr = "";
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP retrieval: ${stderr}`)), 10_000);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const line of output.trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.id === 3) { clearTimeout(timeout); child.kill("SIGKILL"); resolve(message); }
    }
  });
  child.on("error", reject);
  child.on("exit", (code) => { if (code !== 0) reject(new Error(`MCP exited ${code}: ${stderr}`)); });
  child.stdin.end(`${requests.map(JSON.stringify).join("\n")}\n`);
});
const text = retrieved?.result?.content?.[0]?.text;
if (!text || !JSON.parse(text).some((memory) => memory.content === "SQLite package smoke")) throw new Error("SQLite MCP retrieval did not return the stored memory");
NODE
