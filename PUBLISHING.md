# Publishing to npm

## Prerequisites

- npm account with access to the `@memstack` org
- Authenticated locally (`npm login`)
- pnpm installed

## Quick publish

```bash
# 1. Ensure clean working tree and passing tests
pnpm check && pnpm test

# 2. Bump version (update package.json version field)
#    Edit package.json "version" or use:
npm version patch   # 0.1.0 → 0.1.1
npm version minor   # 0.1.0 → 0.2.0
npm version major   # 0.1.0 → 1.0.0

# 3. Build and publish
pnpm publish --access public
```

## What gets published

The `"files"` field in `package.json` includes only `dist/` and `src/`. The `prepublishOnly` script runs `pnpm build && pnpm check` automatically, so you never publish broken builds.

**Included:**
- `dist/` — compiled CJS (`dist/index.js`), ESM (`dist/index.mjs`), types (`dist/index.d.ts`)
- `src/` — raw TypeScript source (useful for sourcemaps and IDE navigation)

**Excluded** (via `.gitignore` or not listed in `"files"`):
- `test/`, `node_modules/`, config files, lockfile

## Versioning

Version format: `MAJOR.MINOR.PATCH`

| Bump | When |
|------|------|
| `patch` | Bug fixes, internal refactors |
| `minor` | New adapters, new features |
| `major` | Breaking API changes |

## After publishing

```bash
# Tag the release
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```
