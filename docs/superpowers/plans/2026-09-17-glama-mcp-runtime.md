# Glama MCP Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make packed `@memstack/mcp` installations work with an explicitly chosen storage driver and prove a Glama-compatible Node 22 SQLite MCP container.

**Architecture:** Keep lazy storage drivers external to generated bundles. Packages declare drivers as optional peers, so consumers install only their selected backend. An empty-consumer smoke test installs SQLite explicitly; a separate Node 22 Docker image runs the MCP stdio entrypoint directly, because Glama wraps stdio itself.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript, tsup, Docker, MCP stdio JSON-RPC, better-sqlite3.

---

## File map

- `tsup.config.ts`: external bundle declarations for lazy drivers.
- `package.json`: Core Postgres-driver peer contract and Docker smoke script.
- `packages/mcp/package.json`: MCP SQLite/Redis peer contract.
- `scripts/verification/smoke-packages.sh`: clean packed-consumer test.
- `packages/mcp/Dockerfile`: Glama-targeted MCP image, separate from REST.
- `scripts/verification/smoke-mcp-docker.sh`: Docker stdio protocol test.
- `.github/workflows/ci.yml`: required Docker-MCP verification job.
- `packages/mcp/README.md`: explicit install/deployment instructions.

### Task 1: Write the failing packed-consumer SQLite regression

**Files:**
- Modify: `scripts/verification/smoke-packages.sh`

- [ ] **Step 1: Install SQLite explicitly in the empty consumer**

Replace the package install command with:

```bash
pnpm add --allow-build=better-sqlite3 "$pack_dir"/*.tgz better-sqlite3
```

- [ ] **Step 2: Add a stdio MCP round trip**

Spawn `./node_modules/.bin/memstack-mcp` with `MEMSTACK_STORAGE=sqlite`, a temporary `SQLITE_PATH`, `MEMSTACK_EMBED_ON_STORE=false`, and `OPENAI_API_KEY=package-smoke`. Send newline-delimited JSON-RPC for `initialize`, `notifications/initialized`, `memory_store` with `SQLite package smoke`, and `memory_retrieve`; fail for child exit, timeout, malformed response, or missing stored content.

- [ ] **Step 3: Assert the future artifact contract**

Read the packed MCP manifest and require `better-sqlite3`/`ioredis` optional peer entries. Read `dist/cli.js` and require dynamic external imports for both drivers.

- [ ] **Step 4: Prove the regression fails before metadata/build changes**

Run: `pnpm build:all && pnpm smoke:packages`

Expected: FAIL on the external-import or peer-contract assertion.

### Task 2: Externalize drivers and publish optional peer contracts

**Files:**
- Modify: `tsup.config.ts`
- Modify: `packages/mcp/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Keep lazy SQLite and Redis imports external**

Change the shared config to include all lazy database modules:

```ts
external: ["better-sqlite3", "ioredis", "postgres", "pg", /* existing modules */]
```

Keep `@memstack/config-env` in `noExternal`; its source remains bundled, but native/client imports resolve from the consumer.

- [ ] **Step 2: Define MCP's explicit driver contract**

Add to `packages/mcp/package.json`:

```json
"peerDependencies": { "better-sqlite3": "^11.10.0", "ioredis": "^5.11.1" },
"peerDependenciesMeta": {
  "better-sqlite3": { "optional": true },
  "ioredis": { "optional": true }
}
```

- [ ] **Step 3: Define Core's Postgres contract**

Add `postgres` and `pg` as optional peers in root `package.json`; retain both because the adapter first loads `postgres`, then falls back to `pg`. Do not turn any driver into an automatic dependency.

- [ ] **Step 4: Verify the repair**

Run: `pnpm install --lockfile-only && pnpm build:all && pnpm smoke:packages`

Expected: PASS; the packed consumer explicitly installs SQLite and completes store/retrieve.

- [ ] **Step 5: Commit**

```bash
git add tsup.config.ts package.json packages/mcp/package.json pnpm-lock.yaml scripts/verification/smoke-packages.sh
git commit -m "fix: externalize MCP storage drivers"
```

### Task 3: Add the Glama-compatible image and verification gate

**Files:**
- Create: `packages/mcp/Dockerfile`
- Create: `scripts/verification/smoke-mcp-docker.sh`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the Node 22 Debian image**

Use a builder stage to install the locked workspace and run `pnpm build:all`. In `node:22-bookworm-slim`, install local packed Core/MCP tarballs plus `better-sqlite3`, create `/data`, and set:

```dockerfile
ENV MEMSTACK_STORAGE=sqlite SQLITE_PATH=/data/memstack.db MEMSTACK_EMBED_ON_STORE=false
CMD ["./node_modules/.bin/memstack-mcp"]
```

Do not include `mcp-proxy`: Glama wraps stdio servers when exposing hosted HTTP.

- [ ] **Step 2: Add a Docker protocol smoke script**

Build `packages/mcp/Dockerfile`, run it with stdin open and a placeholder `OPENAI_API_KEY`, feed the Task 1 MCP exchange, and assert the SQLite retrieval. Print stderr on failure; remove the container in an exit trap.

- [ ] **Step 3: Gate CI**

Add `smoke:mcp-docker` to root scripts. Add a CI `mcp-docker` job after `pnpm build:all`, include it in `verification.needs`, and upload its log artifact when it fails.

- [ ] **Step 4: Verify and commit**

Run: `pnpm smoke:mcp-docker`

Expected: PASS.

```bash
git add packages/mcp/Dockerfile scripts/verification/smoke-mcp-docker.sh package.json .github/workflows/ci.yml
git commit -m "test: verify Glama MCP container runtime"
```

### Task 4: Document only supported installation paths

**Files:**
- Modify: `packages/mcp/README.md`

- [ ] **Step 1: Document explicit installs**

Use these tested commands:

```bash
npm install @memstack/mcp
npm install @memstack/mcp better-sqlite3
npm install @memstack/mcp ioredis
npm install @memstack/mcp postgres
```

Explain that memory/disk/Markdown require only the base package; SQLite needs a writable database path and lifecycle scripts; Postgres requires pgvector; drivers are deliberately not auto-installed.

- [ ] **Step 2: Document Glama correctly**

Point to `packages/mcp/Dockerfile`, require a persistent `/data` volume and encrypted LLM credentials, and state that Glama wraps the stdio command. Keep the REST server Dockerfile clearly separate.

- [ ] **Step 3: Verify and commit**

Run: `pnpm build:all && pnpm smoke:packages && pnpm smoke:mcp-docker`

Expected: PASS.

```bash
git add packages/mcp/README.md
git commit -m "docs: clarify MCP storage installation"
```

### Task 5: Complete verification and open the PR

**Files:**
- Verify only: repository root and CI evidence

- [ ] **Step 1: Run release verification**

Run: `corepack enable && pnpm install --frozen-lockfile && pnpm verify`

Expected: exit 0. If a backend or Docker is unavailable, record exact command/logs and do not claim release readiness.

- [ ] **Step 2: Check the final patch**

Run: `git diff origin/main...HEAD --check && git status --short && git log --oneline origin/main..HEAD`

Expected: no whitespace errors and only focused changes.

- [ ] **Step 3: Create a PR, but do not publish**

Title: `fix: make MCP storage drivers installable in Glama`. Include package and Docker smoke evidence. Do not publish npm packages, create a release, or trigger Glama deployment.
