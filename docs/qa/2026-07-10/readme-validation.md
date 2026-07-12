# README Validation Pass — 2026-07-11

Walked each README as a first-time user, running documented examples verbatim
against the built packages. Four Core README issues found and fixed (F1–F4).

## Per-README results

| README | Result | Notes |
|---|---|---|
| `packages/server/README.md` | ✅ accurate | 21-route table matches `index.ts` exactly; Docker tag + validation-message fixes verified; curl examples valid |
| `packages/mcp/README.md` | ✅ accurate | `--http --port 3939` matches `cli.ts`; 18 tools match; input-handling notes match code |
| `packages/cli/README.md` | ✅ accurate | importance clamp, tag filter, actor trim, invalid-prune error, empty-import error all verified live |
| `README.md` (core) | ⚠️ 4 issues → fixed | see below |

## Findings & fixes

### F1 — Flagship "Store and retrieve" example returned 0 results (High)
- **Cause:** InMemory/Disk/Markdown adapters matched `query` as a whole-phrase
  substring. README query `"login error"` is not a substring of
  "User reports login failing with error 503", so `.includes()` → false → 0 results.
- **Fix:** tokenize `query` on whitespace, match memories containing ANY term
  (standard keyword-search OR semantics, matching the doc's "keyword matching" wording).
- **Files:** `src/adapters/storage/memory.ts`, `disk.ts`, `markdown.ts`
- **Verified:** `retrieve({ query: "login error", strategy: "hybrid" })` → **1 result** (was 0).
- **Test safety:** all existing query tests use single-word queries → unaffected.

### F2 — Auto-prune doc said "on every store()" (Medium)
- **Cause:** doc inaccurate. Auto-summarize/prune run inside `process()`, and prune is
  throttled by `pruneInterval` (default 100). `store()` never triggers them.
- **Fix:** corrected constructor + Configuration comments; added an explanatory note.
- **Files:** `README.md`

### F3 — Core `ms.import()` didn't preserve createdAt (Medium)
- **Cause:** `client.import()` passed JSON-parsed memories (string `createdAt`)
  straight to `storeBatch`; adapters stored the string, violating `Memory.createdAt: Date`.
  Affected core + server + MCP import (all route through `client.import()`); only the
  CLI worked around it manually.
- **Fix:** coerce string `createdAt`/`expiresAt` → `Date` centrally in `client.import()`;
  removed the now-redundant manual loop in the CLI.
- **Files:** `src/client.ts`, `packages/cli/src/cli.ts`
- **Verified:** new regression test `test/client.test.ts` — export → `JSON.stringify` →
  `JSON.parse` → `import` yields `createdAt instanceof Date` equal to the original.

### F4 — Undocumented config options (Low)
- **Fix:** documented `pruneInterval`, `autoImportance`, `autoTags`,
  `summarizationPrompt`, and the `onError` hook in the constructor + Configuration sections.
- **Files:** `README.md`

## Verification

```
pnpm check   # 0 type errors
pnpm test    # 470/470 pass (was 469 + F3 regression test)
```

Flagship README snippet re-run live (mock LLM + embeddings):
```
FLAGSHIP retrieve('login error') -> 1 result(s) PASS
compileContext systemPrompt non-empty: PASS
```

## Files changed

| File | Change |
|---|---|
| `src/adapters/storage/memory.ts` | tokenized keyword match |
| `src/adapters/storage/disk.ts` | tokenized keyword match |
| `src/adapters/storage/markdown.ts` | tokenized keyword match |
| `src/client.ts` | import() coerces createdAt/expiresAt string→Date |
| `packages/cli/src/cli.ts` | dropped redundant manual coercion (kept empty-snapshot guard) |
| `README.md` | F2 + F4 doc corrections |
| `test/client.test.ts` | +1 regression test (createdAt round-trip) |
