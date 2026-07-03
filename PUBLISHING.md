# Publishing MemStack

Monorepo with pnpm workspaces. Four packages published independently.

## Package list

| Package | npm name | Directory |
|---|---|---|
| Core | `@memstack/core` | `/` (root) |
| MCP | `@memstack/mcp` | `packages/mcp/` |
| CLI | `@memstack/cli` | `packages/cli/` |
| Server | `@memstack/server` | `packages/server/` |

## Release checklist (per package)

1. Update version in `package.json`
2. Run the package's prepublishOnly script: `pnpm build && pnpm check && pnpm test`
3. Verify `dist/` contains correct files
4. Publish: `npm publish --access public`
5. Git tag: `git tag v<version>-<package>` (e.g., `v0.2.0-core`, `v0.1.0-mcp`)
6. Push tag: `git push origin v<version>-<package>`

## Publishing \@memstack/core

```bash
cd /path/to/memstack
pnpm build && pnpm check && pnpm test
npm publish --access public
git tag v0.2.0-core
git push origin v0.2.0-core
```

## Publishing \@memstack/mcp

```bash
cd packages/mcp
# Verify version in package.json
pnpm install  # from root to resolve workspace deps
pnpm build && pnpm check && pnpm test
npm publish --access public
cd ../..
git tag v0.1.0-mcp
git push origin v0.1.0-mcp
```

## Publishing \@memstack/cli

```bash
cd packages/cli
# Verify version in package.json
pnpm build && pnpm check && pnpm test
npm publish --access public
cd ../..
git tag v0.1.0-cli
git push origin v0.1.0-cli
```

## Publishing \@memstack/server

```bash
cd packages/server
# Build core first (server depends on it):
cd ../.. && pnpm build && cd packages/server
pnpm build && pnpm check && pnpm test
npm publish --access public
cd ../..
git tag v0.1.0-server
git push origin v0.1.0-server
```

## Pre-publish verification

Before publishing any package, run from root:
```bash
pnpm install
pnpm build   # builds all packages
pnpm check   # type-check all packages
pnpm test    # 393 unit tests must pass
pnpm test:e2e  # 82 e2e tests (requires Docker)
```

## Docker release (server)

The server ships as a Docker image on GitHub Container Registry (ghcr.io).
Images are tagged to match the core version.

**This is automated.** Pushing a `v*` tag triggers the `docker` job in
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), which builds
`packages/server/Dockerfile` and pushes both `ghcr.io/isiomac/memstack-server:<version>`
and `:latest` using the repo's built-in `GITHUB_TOKEN` (no manual login or
PAT needed). Pushing the release tag is the only step required — the sections
below are the manual fallback if you ever need to build/push by hand.

### First-time setup (manual fallback only)

```bash
# Create a classic token at https://github.com/settings/tokens
# Scopes: write:packages, delete:packages

# Login to GHCR (uses your GitHub username)
echo "YOUR_GITHUB_TOKEN" | docker login ghcr.io -u isiomaC --password-stdin
```

### Build and push (manual fallback only)

```bash
VERSION=0.6.4
docker build -f packages/server/Dockerfile -t ghcr.io/isiomac/memstack-server:$VERSION .
docker build -f packages/server/Dockerfile -t ghcr.io/isiomac/memstack-server:latest .
docker push ghcr.io/isiomac/memstack-server:$VERSION
docker push ghcr.io/isiomac/memstack-server:latest
```

Note: the Dockerfile now also copies and flattens `packages/config-env` (added
alongside `packages/core`) — if you add another internal `workspace:*`
dependency to the server, update both the Dockerfile's `COPY`/`sed` steps and
this note.

### Make image public

By default GHCR images are private. To make public:

```bash
# Via GitHub UI: https://github.com/isiomaC/memstack/pkgs/container/memstack-server
# Settings → Change visibility → Public
```

Or via API:

```bash
curl -X PATCH -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/orgs/isiomaC/packages/container/memstack-server/visibility \
  -d '{"visibility":"public"}'
```

### User pull command

```bash
docker run -p 3000:3000 \
  -e MEMSTACK_STORAGE=postgres \
  -e DATABASE_URL=postgresql://... \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/isiomac/memstack-server:v0.6.4
```

## Versioning conventions

- Core follows the adapter delivery phases (v0.2.0, v0.3.0, etc.)
- MCP, CLI, and Server version independently from core
- All packages currently pre-1.0 — breaking changes expected
