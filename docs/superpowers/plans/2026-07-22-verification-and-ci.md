# Verification and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemStack's declared verification command reliable locally and in CI, validate distributable artifacts, gate releases, and align documentation with measured results.

**Architecture:** Repair the E2E suites first, then expose small verification scripts with one responsibility each. Compose those scripts through root package commands and thin GitHub Actions workflows so local and hosted verification use the same behavior. Keep product APIs unchanged unless a failing LanceDB regression test proves a narrowly scoped adapter defect.

**Tech Stack:** TypeScript 5.7, Vitest 1, pnpm 10, Bash, Docker Compose, GitHub Actions, tsup, Node.js 18 and 22

---

## File Map

- `e2e/sqlite.e2e.ts`: normal Vitest coverage with dependency-aware skip.
- `e2e/chroma.e2e.ts`: normal Vitest coverage with separate client and embedder capability checks.
- `e2e/lancedb.e2e.ts`: normal Vitest coverage with isolated table lifecycle and deletion assertions.
- `vitest.e2e.config.ts`: E2E timeouts and explicit suite inventory.
- `e2e/run-all.sh`: bounded service startup, one unfiltered Vitest run, logs, and cleanup.
- `scripts/verification/build-all.sh`: build core and every workspace package in dependency order.
- `scripts/verification/smoke-artifacts.sh`: black-box core, CLI, MCP, and server checks.
- `scripts/verification/smoke-packages.sh`: pack and install publishable tarballs in a clean project.
- `scripts/verification/smoke-docker.sh`: build, start, probe, and clean up the server image.
- `scripts/verification/check-versions.mjs`: compare publishable package versions with each other and an optional tag.
- `scripts/verification/summary.sh`: write a concise GitHub Actions step summary.
- `package.json`: explicit scoped commands and the top-level verification command.
- `.github/workflows/ci.yml`: runtime checks, real-backend E2E, artifacts, Docker, logs, and stable gate.
- `.github/workflows/publish.yml`: verify before npm/GHCR publication and smoke-test the exact image.
- `README.md`, `CONTRIBUTING.md`, `docs/internal/AGENTS.md`, `docs/internal/CHECKLIST.md`, `packages/server/README.md`: measured counts and precise support claims.
- `codex.md`: mark only requirements demonstrated by fresh verification output.

### Task 1: Convert SQLite E2E to Vitest

**Files:**
- Modify: `e2e/sqlite.e2e.ts`
- Modify: `vitest.e2e.config.ts`

- [ ] **Step 1: Replace script assertions with a skipped-suite capability probe**

Use a top-level dynamic import that captures only module-unavailability, then select `describe` or `describe.skip`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQLiteStorageAdapter } from "../src/adapters/storage/sqlite.js";

let BetterSqlite3: (new (path: string) => SQLiteDatabase) | undefined;
try {
  BetterSqlite3 = (await import("better-sqlite3")).default as typeof BetterSqlite3;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const sqliteSuite = BetterSqlite3 ? describe : describe.skip;
sqliteSuite("SQLiteStorageAdapter E2E (requires better-sqlite3)", () => {
  // initialize in beforeAll, close in afterAll, and express each former check as it/expect
});
```

- [ ] **Step 2: Preserve all ten behavioral assertions as named Vitest tests**

Cover store/get/missing get, important/recent retrieval, count, touch, batch/deleteMany, and delete. Use one in-memory database and retain returned IDs rather than relying on counts alone.

- [ ] **Step 3: Prove the file cannot terminate Vitest**

Run: `rg -n "process\\.exit" e2e/sqlite.e2e.ts`

Expected: no matches.

- [ ] **Step 4: Run the isolated suite**

Run: `npx vitest run --config vitest.e2e.config.ts e2e/sqlite.e2e.ts --reporter=verbose`

Expected: ten passing assertions, or one visibly skipped suite naming `better-sqlite3`.

- [ ] **Step 5: Run mandatory fast verification**

Run: `pnpm check && pnpm test`

Expected: zero type errors and all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add e2e/sqlite.e2e.ts vitest.e2e.config.ts
git commit -m "test: convert SQLite E2E to Vitest"
```

### Task 2: Convert Chroma E2E to Vitest

**Files:**
- Modify: `e2e/chroma.e2e.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the Chroma default embedder needed by the installed client**

Run: `pnpm add -D @chroma-core/default-embed`

Expected: `package.json` and `pnpm-lock.yaml` add a pinned compatible dependency.

- [ ] **Step 2: Add distinct capability probes**

```ts
type ChromaCapability =
  | { available: true; ChromaClient: ChromaClientConstructor; DefaultEmbeddingFunction: EmbeddingConstructor }
  | { available: false; reason: "chromadb client unavailable" | "default embedding function unavailable" };
```

Import `chromadb` and `@chroma-core/default-embed` separately. Only `ERR_MODULE_NOT_FOUND` selects a skipped suite; connection and collection errors remain failures.

- [ ] **Step 3: Express the former script checks as isolated Vitest assertions**

Create a unique collection in `beforeAll`, delete it in `afterAll`, and cover store/get/missing get, retrieval strategies, count, batch/deleteMany, and delete.

- [ ] **Step 4: Verify the failure modes and isolated suite**

Run: `rg -n "process\\.exit" e2e/chroma.e2e.ts`

Expected: no matches.

Run: `npx vitest run --config vitest.e2e.config.ts e2e/chroma.e2e.ts --reporter=verbose`

Expected: behavioral tests pass, or the visible skip names the exact missing capability.

- [ ] **Step 5: Run mandatory fast verification and commit**

Run: `pnpm check && pnpm test`

Expected: zero type errors and all unit tests pass.

```bash
git add e2e/chroma.e2e.ts package.json pnpm-lock.yaml
git commit -m "test: convert Chroma E2E to Vitest"
```

### Task 3: Convert and Diagnose LanceDB E2E

**Files:**
- Modify: `e2e/lancedb.e2e.ts`
- Test if defect found: `test/lancedb-storage.test.ts`
- Modify if defect found: `src/adapters/storage/lancedb.ts`

- [ ] **Step 1: Write the LanceDB lifecycle as Vitest hooks**

Connect to a `mkdtemp` directory, create a unique table in `beforeAll`, initialize the adapter, and drop the table plus remove the temporary directory in `afterAll`.

- [ ] **Step 2: Add a deletion-state regression assertion**

```ts
it("deleteMany removes only the requested batch", async () => {
  const original = await adapter.store(memoryInput("original"));
  const batch = await adapter.storeBatch([memoryInput("B1"), memoryInput("B2")]);
  expect(await adapter.deleteMany(batch.map(({ id }) => id))).toBe(2);
  expect(await adapter.get(original.id)).toMatchObject({ id: original.id });
  expect(await Promise.all(batch.map(({ id }) => adapter.get(id)))).toEqual([null, null]);
});
```

- [ ] **Step 3: Run the regression in isolation**

Run: `npx vitest run --config vitest.e2e.config.ts e2e/lancedb.e2e.ts --reporter=verbose`

Expected: the original record survives `deleteMany`; any failure identifies the operation that loses it.

- [ ] **Step 4: If the adapter is defective, reproduce with a unit test and make the smallest fix**

Run: `npx vitest run test/lancedb-storage.test.ts --reporter=verbose`

Expected: the new regression fails before and passes after the focused adapter change. Do not change adapter code if the E2E script's cleanup order was the sole cause.

- [ ] **Step 5: Remove all E2E process exits and run the configured command**

Run: `rg -n "process\\.exit" e2e`

Expected: no matches in files included by `vitest.e2e.config.ts`.

Run: `pnpm test:e2e`

Expected: exit code zero when configured services are available; optional local capabilities appear as skips.

- [ ] **Step 6: Run mandatory fast verification and commit**

Run: `pnpm check && pnpm test`

```bash
git add e2e/lancedb.e2e.ts test/lancedb-storage.test.ts src/adapters/storage/lancedb.ts
git commit -m "test: make LanceDB E2E lifecycle reliable"
```

Stage only files that actually changed.

### Task 4: Make E2E Service Orchestration Reliable

**Files:**
- Modify: `docker-compose.yml`
- Modify: `e2e/run-all.sh`

- [ ] **Step 1: Correct Compose health checks and pin service image versions**

Remove the duplicate Neo4j `retries`, use the endpoints already exercised by tests, and replace floating `latest` tags with explicit compatible versions.

- [ ] **Step 2: Replace name-dependent loops with bounded Compose health waiting**

```bash
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then docker compose logs --no-color > artifacts/e2e-services.log; fi
  docker compose down -v
  exit "$status"
}
trap cleanup EXIT INT TERM
docker compose up -d --wait postgres redis qdrant neo4j weaviate mongodb
pnpm test:e2e 2>&1 | tee artifacts/e2e-vitest.log
```

Do not filter Vitest output or run the same suite once per adapter.

- [ ] **Step 3: Run the full E2E acceptance command through the runner**

Run: `bash e2e/run-all.sh`

Expected: all services become healthy, one Vitest invocation exits zero, and cleanup removes containers and volumes.

- [ ] **Step 4: Run mandatory fast verification and commit**

Run: `pnpm check && pnpm test`

```bash
git add docker-compose.yml e2e/run-all.sh
git commit -m "test: make E2E orchestration deterministic"
```

### Task 5: Add Explicit Build and Artifact Smoke Commands

**Files:**
- Create: `scripts/verification/build-all.sh`
- Create: `scripts/verification/smoke-artifacts.sh`
- Modify: `package.json`

- [ ] **Step 1: Add dependency-ordered build script**

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm build
pnpm --filter @memstack/config-env build
pnpm --filter @memstack/cli build
pnpm --filter @memstack/mcp build
pnpm --filter @memstack/server build
```

- [ ] **Step 2: Add black-box artifact checks**

The script must create a temporary directory and trap cleanup; test `import()` and `require()` against `dist/index.js` and `dist/index.cjs`; invoke built CLI store/retrieve/stats across processes with disk storage; initialize MCP over JSON-RPC and assert 18 tools; start built Node server, wait for `/health`, then assert store/retrieve/count.

- [ ] **Step 3: Add explicit root scripts**

```json
{
  "check:all": "pnpm check && pnpm -r --if-present check",
  "test:unit": "vitest run test/",
  "test:packages": "pnpm -r --if-present test",
  "build:all": "bash scripts/verification/build-all.sh",
  "smoke:artifacts": "bash scripts/verification/smoke-artifacts.sh"
}
```

Keep `test` intentionally scoped to core tests so root and package totals are not double-counted.

- [ ] **Step 4: Run and commit**

Run: `pnpm check:all && pnpm test:unit && pnpm test:packages && pnpm build:all && pnpm smoke:artifacts`

Expected: every command exits zero and built binaries are the code under test.

```bash
git add package.json scripts/verification/build-all.sh scripts/verification/smoke-artifacts.sh
git commit -m "test: add built artifact verification"
```

### Task 6: Add Packed-Package and Docker Smoke Tests

**Files:**
- Create: `scripts/verification/smoke-packages.sh`
- Create: `scripts/verification/smoke-docker.sh`
- Create: `scripts/verification/check-versions.mjs`
- Modify: `package.json`

- [ ] **Step 1: Implement version validation**

Read root, CLI, MCP, and server package JSON; fail if versions differ. When `GITHUB_REF_NAME` starts with `v`, also require `version === GITHUB_REF_NAME.slice(1)`.

- [ ] **Step 2: Implement clean tarball installation**

Run `pnpm pack --pack-destination` for each publishable package, inspect each archive with `tar -tf`, rewrite only packed manifests in a temporary staging area so internal workspace dependencies point to their tarballs, then install into a clean temporary consumer with workspace linking unavailable. Assert exports, declaration files, and CLI/MCP/server bin targets.

- [ ] **Step 3: Implement Docker black-box smoke test**

Build `packages/server/Dockerfile`, start with disk storage on an ephemeral host port, poll `/health` with a bounded loop, perform store/retrieve, capture logs on failure, and trap container/image cleanup.

- [ ] **Step 4: Compose the top-level verification command**

```json
{
  "smoke:packages": "bash scripts/verification/smoke-packages.sh",
  "smoke:docker": "bash scripts/verification/smoke-docker.sh",
  "verify": "pnpm check:all && pnpm test:unit && pnpm test:packages && pnpm build:all && pnpm test:e2e && pnpm smoke:artifacts && pnpm smoke:packages && pnpm smoke:docker"
}
```

- [ ] **Step 5: Run and commit**

Run: `pnpm build:all && pnpm smoke:packages && pnpm smoke:docker`

Expected: tarballs work without workspace links and the image passes the HTTP round trip.

```bash
git add package.json scripts/verification/check-versions.mjs scripts/verification/smoke-packages.sh scripts/verification/smoke-docker.sh
git commit -m "test: verify packed packages and Docker image"
```

### Task 7: Rebuild Pull-Request CI Around Shared Verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `scripts/verification/summary.sh`

- [ ] **Step 1: Add Node 18 and 22 compatibility jobs**

Use `actions/checkout@v4`, `pnpm/action-setup@v4` with pnpm 10, and `actions/setup-node@v4` with pnpm caching. Run install, explicit checks/tests, and builds on both runtimes.

- [ ] **Step 2: Add the real-backend E2E job**

Start the six Compose services with `docker compose up -d --wait`, run `pnpm test:e2e` once, upload `artifacts/e2e-vitest.log` and service logs on failure, and always run `docker compose down -v`.

- [ ] **Step 3: Add artifact and Docker jobs**

Run shared build/smoke scripts. Upload server and container logs on failure. Do not duplicate their internal shell logic in YAML.

- [ ] **Step 4: Add a stable aggregate gate and summary**

Create a `verification` job with `if: always()`, `needs` all verification jobs, and fail unless every required result is `success`. Append measured results to `$GITHUB_STEP_SUMMARY`.

- [ ] **Step 5: Validate workflow syntax and local equivalents**

Run: `pnpm check:all && pnpm test:unit && pnpm test:packages && pnpm build:all`

Expected: zero failures. Review `.github/workflows/ci.yml` to confirm no Vitest output is piped through `grep`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml scripts/verification/summary.sh
git commit -m "ci: add complete verification gate"
```

### Task 8: Gate Publishing and Docker Pushes

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Add a pre-publication verification job**

Run the same shared check, test, build, E2E, artifact, package, and Docker commands as CI. Validate package versions against the pushed tag before any registry credentials are used.

- [ ] **Step 2: Make npm publication depend on verification**

Add `needs: verify` to the publish job. Preserve the npm destination and existing `NODE_AUTH_TOKEN` handling.

- [ ] **Step 3: Smoke-test the exact Docker image before push**

Build a local tag, run `scripts/verification/smoke-docker.sh` against that tag, then authenticate and push only after it passes. Preserve GHCR metadata and permissions.

- [ ] **Step 4: Validate and commit**

Run: `node scripts/verification/check-versions.mjs`

Expected: all publishable packages report version `0.7.0`.

```bash
git add .github/workflows/publish.yml
git commit -m "ci: gate releases on complete verification"
```

### Task 9: Correct Documentation From Fresh Output

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/internal/AGENTS.md`
- Modify: `docs/internal/CHECKLIST.md`
- Modify: `packages/server/README.md`
- Modify: `codex.md`

- [ ] **Step 1: Capture authoritative counts**

Run: `pnpm test:unit -- --reporter=verbose`

Run: `pnpm test:packages -- --reporter=verbose`

Run: `pnpm test:e2e -- --reporter=verbose`

Record file, passed, skipped, and failed counts without adding overlapping root and package runs.

- [ ] **Step 2: Verify inventories mechanically**

Run: `find src/adapters/storage -maxdepth 1 -name '*.ts' | wc -l`

Run: `rg -n "StorageAdapter" src/index.ts`

Run: `printf '{"jsonrpc":"2.0","method":"tools/list","id":1}\\n' | node packages/mcp/dist/cli.js`

Run: `rg -n "app\\.(get|post|put|patch|delete)" packages/server/src`

Expected: documentation uses the measured 18 implementations, 12 exports including experimental SQLite, 18 MCP tools, 2 resources, 1 prompt, and 20 operational REST routes when confirmed by output.

- [ ] **Step 3: Define support terminology and limitations**

Document exact meanings for production-ready, experimental, mock-tested, and real-service E2E verified. State that Pinecone, Upstash, Mem0, Zep, and Turso live cloud compatibility is unverified and provider tests are mocked unless an opt-in live job is added.

- [ ] **Step 4: Update commands and release examples**

Document `pnpm verify`, the stable GitHub `verification` check for branch protection, current Docker version examples, and the cleanup/log behavior.

- [ ] **Step 5: Check off only demonstrated checklist items**

Update `codex.md` only where the corresponding command has fresh successful output. Leave externally configured branch protection and unrun live-cloud checks unchecked with an explanation.

- [ ] **Step 6: Run the final verification tiers**

Run: `pnpm check && pnpm test`

Run: `pnpm -r check && pnpm test:packages && pnpm build:all`

Run: `bash e2e/run-all.sh`

Run: `pnpm smoke:artifacts && pnpm smoke:packages && pnpm smoke:docker`

Expected: all locally available tiers exit zero; fresh counts match documentation.

- [ ] **Step 7: Commit**

```bash
git add README.md CONTRIBUTING.md docs/internal/AGENTS.md docs/internal/CHECKLIST.md packages/server/README.md codex.md
git commit -m "docs: align verification claims with CI"
```

### Task 10: Final Regression and Commit Audit

**Files:**
- Verify only

- [ ] **Step 1: Confirm no unrelated changes or process exits**

Run: `git status --short && git diff --check && rg -n "process\\.exit" e2e`

Expected: only intentional files are present, no whitespace errors, and no E2E process exits.

- [ ] **Step 2: Run the complete documented command**

Run: `pnpm verify`

Expected: exit code zero with all services available.

- [ ] **Step 3: Audit commit attribution**

Run: `git log --format='%h %an <%ae> | %cn <%ce> | %s' 06f72de..HEAD`

Expected: every new commit uses the repository owner's configured author and committer identity, with no Codex co-author trailers.

- [ ] **Step 4: Report any external-only completion step**

Identify the stable `verification` check that the repository owner must select in GitHub branch protection. Do not claim this setting was changed by repository code.
