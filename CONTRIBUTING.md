# Contributing to MemStack

## Setup

```bash
git clone https://github.com/isiomaC/memstack.git
cd memstack
pnpm install
```

## Development

```bash
pnpm build:all       # build core and every workspace package
pnpm check:all       # type-check core and every workspace package
pnpm test            # 407 core tests
pnpm test:packages   # 78 package tests
pnpm test:e2e:run    # start backends, run 80 E2E tests, and clean up
pnpm verify          # complete checks, tests, builds, E2E, package, and Docker verification
```

To keep the Docker services running while iterating on E2E tests:

```bash
docker compose up -d
pnpm test:e2e
docker compose down -v
```

Working on a sub-package:

```bash
cd packages/mcp   # or cli / server
pnpm build
pnpm test
```

## Storage adapters

All adapters live in `src/adapters/storage/`. Each adapter must implement the `StorageProvider` interface (`src/interfaces.ts`) and follow the zero-peer-dependency rule: the caller injects the client, and no MemStack package depends on, or installs, a storage driver. Users install the driver for their store themselves.

Add a unit test file at `test/<name>-storage.test.ts` and an E2E file at `e2e/<name>.e2e.ts` if the backend can run in Docker.

Harness memory works on every adapter. For a new adapter:

- Run it through the harness conformance suite: add it to `test/harness-conformance.test.ts` (local backends) or `e2e/harness-conformance.e2e.ts` (Docker backends).
- Honor `retrieve({ touch: false })` if `retrieve` normally marks memories as accessed.
- Declare `capabilities.multiProcess: true` only if two processes can write at once without errors or lost writes, and prove it in `e2e/multi-process.e2e.ts`. Otherwise declare `false`, so `memstack doctor` can warn.

## Pull requests

- Keep PRs focused — one adapter, one feature, one fix per PR.
- Run `pnpm check && pnpm test` during development and `pnpm verify` before opening a PR; CI's `verification` job blocks on failures when configured as a required check.
- Describe *why* in the PR body, not just what changed.
- New adapters should include unit tests and, where possible, an E2E test.

## Reporting issues

Open a GitHub issue with a minimal reproduction. For security issues, see [SECURITY.md](SECURITY.md).
