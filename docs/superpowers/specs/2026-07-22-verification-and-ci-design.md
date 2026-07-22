# Verification and CI Design

## Goal

Implement the complete verification and CI checklist in `codex.md` without changing MemStack's public API or weakening existing coverage. A clean checkout should have one documented verification path that checks every package, runs real-backend E2E tests, validates built and packed artifacts, smoke-tests the server and Docker image, and produces trustworthy diagnostics.

## Scope

The work covers:

- reliable Vitest E2E suites for SQLite, Chroma, and LanceDB;
- real-backend E2E execution in CI;
- deterministic root verification commands;
- built-artifact, packed-package, CLI, MCP, server, and Docker smoke tests;
- release gates equivalent to pull-request verification;
- supported Node runtime coverage;
- CI diagnostics, logs, caching, cleanup, and summaries; and
- corrections to verification, adapter, MCP, REST, Docker, and live-provider documentation.

Live compatibility tests for Pinecone, Upstash, Mem0, Zep, Turso, LLM providers, and embedding providers are not added. Their unverified or mock-tested status will be documented explicitly. GitHub branch protection is also outside repository-controlled configuration; the workflow will expose a stable required check, and documentation will identify the external setting needed to require it.

## Delivery Strategy

Implementation proceeds in independently verifiable slices:

1. Repair the declared E2E command.
2. Establish deterministic local verification commands and artifact smoke tests.
3. Add real-service, runtime-matrix, artifact, and Docker CI coverage.
4. Gate publishing on equivalent checks.
5. Update documentation from fresh verification output.

Each slice must pass core and workspace type checks and unit tests before work continues. Docker-backed checks run after local checks and must preserve complete failure output.

## E2E Test Design

SQLite, Chroma, and LanceDB will become normal Vitest suites using `describe`, test cases, and lifecycle hooks. No included test file may call `process.exit`.

Optional dependencies are detected before selecting the suite. A missing dependency produces a visible skipped suite with a precise reason. SQLite distinguishes an unavailable `better-sqlite3` module from test failures. Chroma distinguishes an unavailable client from an unavailable default embedding function. Unexpected import, initialization, or adapter errors remain failures.

Each suite owns a unique database, collection, table, or actor namespace. Setup belongs in `beforeAll`; cleanup belongs in `afterAll` and does not replace behavioral assertions. LanceDB tests retain IDs for separately created records, assert the state after `deleteMany`, and only delete records that still exist. If this exposes an adapter ID or delete defect, the adapter receives the smallest compatible fix plus a regression test.

The acceptance command is `pnpm test:e2e`, with exit code zero required. Test totals are updated only from fresh command output.

## Local Verification Design

Root package scripts will explicitly define the scope and order of verification. The full command will run:

1. core and package type checks;
2. core and package tests;
3. core and package builds;
4. real-backend E2E;
5. built-artifact and packed-package smoke tests; and
6. Docker image smoke tests.

Reusable scripts under `scripts/verification/` will keep package metadata and environment setup out of workflow YAML. Scripts must use temporary directories, trap cleanup on success or failure, report the command that failed, and avoid workspace links when testing tarballs.

Artifact checks cover ESM import and CommonJS require of `@memstack/core`, built CLI invocation, MCP initialization and tool listing, and built server health/store/retrieve/count requests. Packing checks inspect each publishable tarball, install it in a clean temporary project, and validate exports, declarations, and binary entries. Private packages are validated as build inputs but are not treated as independently publishable.

The Docker smoke test builds the server image, waits for health with a bounded retry loop, performs a store/retrieve round trip, captures logs on failure, and always removes its container.

## CI Design

CI will use shared scripts and artifacts to reduce duplicated setup. It will include:

- explicit core and package verification;
- a supported-runtime matrix including Node 18 and Node 22 unless implementation evidence requires changing the declared engine;
- an E2E job that starts PostgreSQL/pgvector, Redis Stack, Qdrant, Neo4j, Weaviate, and MongoDB;
- readiness checks for every backend before one unfiltered `pnpm test:e2e` invocation;
- complete Vitest and service logs uploaded on failure;
- package and built-artifact smoke tests; and
- a Docker image smoke test.

Generated database state is not cached. pnpm dependency caching is enabled consistently. Tool versions are pinned or intentionally managed in repository configuration. A final stable verification job summarizes passed, skipped, and failed checks and can be selected as the required branch-protection check.

## Release Design

Tag-triggered publication must depend on, call, or rerun the same verification suite used for pull requests. Before publishing, the workflow verifies that all publishable packages use the intended tag version and that packed artifacts install without workspace resolution.

The Docker release job builds and smoke-tests the exact image before registry login and push. A failed smoke test prevents publishing the image. Package publication and image publication retain their existing destinations and credentials.

## Compatibility and Error Handling

No public exports, provider contracts, storage semantics, or runtime dependencies change unless a demonstrated LanceDB defect requires a focused correction. Optional adapters remain optional. Verification scripts fail closed for unexpected errors and skip only explicitly recognized missing optional capabilities.

All long-lived processes and containers have bounded readiness checks and cleanup traps. CI preserves full test output and relevant service logs rather than filtering output through tools that can hide exit status.

## Documentation

Documentation will use fresh output for test counts and will distinguish:

- production-ready;
- experimental;
- mock-tested; and
- real-service E2E verified.

It will record the actual adapter implementation and export inventory, MCP surface, REST routes, current Docker version examples, and the cloud/provider compatibility that remains unverified. The top-level verification command and GitHub branch-protection step will be documented.

## Acceptance Criteria

- `pnpm check` and all package checks pass without type errors.
- Unit and package tests pass with intentional, non-overlapping scope.
- `pnpm test:e2e` exits zero and reports optional skips visibly.
- All configured real database adapters pass against healthy services.
- Core import/require, CLI, MCP, server, packed tarballs, and Docker image pass black-box smoke tests.
- Node 18 and Node 22 execute the supported verification subset successfully, or the engine declaration is deliberately corrected with evidence.
- Pull-request and release workflows use equivalent verification gates.
- Failure artifacts include complete test and relevant container output.
- Published documentation matches fresh verification output and does not claim untested compatibility.
- Existing public API and behavior remain compatible.
