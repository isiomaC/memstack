# Contributing to MemStack

## Setup

```bash
git clone https://github.com/isiomaC/memstack.git
cd memstack
pnpm install
```

## Development

```bash
pnpm build        # build @memstack/core
pnpm check        # TypeScript type check (all packages)
pnpm test         # unit tests (393)
pnpm test:e2e     # E2E tests against real backends (requires Docker)
```

For E2E tests, start the backends first:

```bash
docker compose up -d
pnpm test:e2e
```

Working on a sub-package:

```bash
cd packages/mcp   # or cli / server
pnpm build
pnpm test
```

## Storage adapters

All adapters live in `src/adapters/storage/`. Each adapter must implement the `StorageProvider` interface (`src/interfaces.ts`) and follow the zero-peer-dependency rule — the caller injects the client (see [ADR-0001](docs/adr/0001-no-peer-dependencies.md)).

Add a unit test file at `test/<name>-storage.test.ts` and an E2E file at `e2e/<name>.e2e.ts` if the backend can run in Docker.

## Pull requests

- Keep PRs focused — one adapter, one feature, one fix per PR.
- Run `pnpm check && pnpm test` before opening a PR; CI will block on failures.
- Describe *why* in the PR body, not just what changed.
- New adapters should include unit tests and, where possible, an E2E test.

## Reporting issues

Open a GitHub issue with a minimal reproduction. For security issues, see [SECURITY.md](SECURITY.md).
