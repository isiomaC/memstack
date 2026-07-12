# MemStack QA session — 2026-07-10

## Overview

| Surface | Status | Golden Path | Edge Cases | Findings |
|---|---|---|---|---|
| A — CLI | PASS | 18/18 | 9/11 (2 findings) | 7 |
| B — MCP | PASS | 8/8 | 3/4 (1 finding) | 4 |
| C — REST | PASS | 12/12 | 6/6 | 1 |
| D — Docker/GHCR | BLOCKED | 0/4 | — | 2 |
| E — Core adapters | PASS (partial) | 6/8 Docker-backed | 66/66 vitest e2e | 3 |

Total: 44 golden path, 15 edge cases, ~25 min improvised.
Total findings: 18 (5 severity:crash, 7 severity:wrong-output, 3 severity:confusing-but-works, 3 severity:docs-mismatch)

---

## Findings

### Severity: crash

1. **Docker image broken — zod@^4.0.0 not resolvable**  
   - Severity: crash  
   - Steps: `docker run ghcr.io/isiomac/memstack-server:0.6.4` → logs show `Cannot find package 'hono'`  
   - Expected: Server starts, `/health` responds  
   - Actual: Container crashes because `hono` (and all npm deps) fail to install. Root cause: `"zod": "^4.0.0"` in server's package.json — only beta versions exist on npm (`4.0.0-beta.0` thru `4.0.0-beta.20250410T230029`), no stable `4.0.0`. `bun install --production` fails entirely.  
   - Fix: Pin zod to `^3.0.0` or a specific `4.0.0-beta.X` version.

2. **MCP memory_store with empty arguments creates garbage memory**  
   - Severity: crash (logical — silently creates invalid data)  
   - Steps: `tools/call memory_store {}`  
   - Expected: Clean tool error ("content is required")  
   - Actual: Creates memory with `actorId: "default"`, no content. No error returned.

3. **MCP memory_import with 0 memories crashes**  
   - Severity: crash  
   - Steps: `tools/call memory_import` with `{"actorId":"x","snapshot":"{\"version\":1,\"memories\":[],\"exportedAt\":\"...\"}"}`  
   - Expected: 0 imported, clean message  
   - Actual: `{"error":"Cannot read properties of undefined (reading 'filter')"}` — raw JS error.

4. **SIGTERM to Anthropic adapter (no @anthropic-ai/sdk)**
   - Severity: crash  
   - Steps: Construct `AnthropicLLMAdapter`, call `.complete()`  
   - Expected: Graceful error or documented requirement  
   - Actual: `MemStackError: Cannot find package '@anthropic-ai/sdk'` — crashes at runtime, no graceful fallback.

### Severity: wrong-output

5. **prune --actor scopes cross-actor** — `prune --actor qa_bob --type byImportance --min-importance 0.9` also prunes `qa_carol`'s memory. Actor filter not respected.

6. **CLI import overwrites createdAt** — Import with `"createdAt":"2026-01-01T00:00:00.000Z"` stored with current timestamp.

7. **CLI importance out-of-range accepted** — `--importance 2` and `--importance=-1` both stored silently (valid range is 0–1).

8. **MCP empty args to store creates default-actor memory** — No validation on required args in MCP tool schema.

9. **MCP integer content accepted** — `memory_store` with `"content":12345` stores the number as-is (no type coercion to string).

10. **CLI prune invalid strategy silent** — `prune --type totally-invalid-strategy` returns `{"count":0}`, exit 0.

11. **LLM adapter returns `text` not `content`** — Response shape uses `text` key but plan/documentation references `content` key. Inconsistency between adapter output and higher-level pipeline (Summarizer wraps it as `summary.content`).

### Severity: confusing-but-works

12. **MCP unknown tool returns no error** — `tools/call memory_teleport` returns no `isError`, server stays alive. Should return "tool not found" error.

13. **CLI actorId not trimmed** — `--actor "  qa_spacey  "` stored with leading/trailing spaces as-is. Different actor from `qa_spacey`.

14. **CLI delete non-existent returns error, not silent** — `delete --id mem_does_not_exist` → `"Memory not found"` error. Debatable UX choice (REST returns 404 JSON, CLI exits 1).

### Severity: docs-mismatch

15. **Docker image tag `v0.6.4` is wrong** — Correct tag is `0.6.4` (no `v` prefix). Plan §6 says `ghcr.io/isiomac/memstack-server:v0.6.4`.

16. **Disk storage concurrency data loss** — 10 concurrent `store` operations, only 7 persisted. Disk storage not safe for concurrent writes.

17. **better-sqlite3 native bindings** — Not compiled for Node v24.16.0. DevDependency requires `pnpm rebuild` or prebuilt bindings.

18. **Empty strings in tags array** — `--tags "a,,b,"` produces `["a","","b",""]`. Trailing/empty comma produces empty string entries.

---

## Surface-by-surface details

### A — CLI
See [surface-a-cli.md](./surface-a-cli.md) for full scenario log. 18 golden path all pass. 2 edge cases fail (importance range, invalid prune strategy). 7 findings total.

### B — MCP
18 tools confirmed (all `memory_*`). 2 resources, 1 prompt. store/retrieve/get/health round-trip works. 4 findings (empty args store, import crash, unknown tool silent, integer type coercion).

### C — REST
12 golden path all pass. 6 edge cases all pass. 0 findings beyond the `--port` flag issue noted in server startup. 200KB payload accepted, rapid-fire 10 stores all persisted.

### D — Docker/GHCR
BLOCKED. Image `ghcr.io/isiomac/memstack-server:0.6.4` exists but crashes on startup due to unresolvable `zod@^4.0.0` dependency. Tag in plan (`v0.6.4`) also incorrect — correct is `0.6.4`.

### E — Core adapters
- **HybridStorageAdapter**: ✅ store/get/retrieve/delete round-trip, edge cases pass
- **PostgresStorageAdapter**: ✅ 14/14 vitest e2e pass
- **RedisStorageAdapter**: ✅ 10/10 vitest e2e pass
- **QdrantStorageAdapter**: ✅ 8/8 vitest e2e pass
- **Neo4jStorageAdapter**: ✅ 11/11 vitest e2e pass
- **WeaviateStorageAdapter**: ✅ 9/9 vitest e2e pass
- **MongoDBStorageAdapter**: ✅ 14/14 vitest e2e pass
- **LanceDBStorageAdapter**: ✅ 10/10 vitest e2e pass
- **SQLiteStorageAdapter**: ⚠️ SKIPPED — better-sqlite3 native bindings not compiled for Node v24
- **ChromaStorageAdapter**: ⚠️ SKIPPED — chromadb `DefaultEmbeddingFunction` import error
- **OpenAI LLM**: ✅ works via mock server (returns `text` key)
- **Groq LLM**: ✅ works via mock server
- **Ollama LLM**: ✅ works via mock server
- **Anthropic LLM**: ❌ crash — `@anthropic-ai/sdk` not installed
- **OpenAI Embedding**: ❌ fail — mock server returns chat format, not embeddings format
- **Cohere Embedding**: ❌ untested (crashed before reaching, same mock limitation)

---

## Environment notes

1. **`better-sqlite3` native bindings** — Not compiled for Node v24.16.0 (darwin arm64). Requires `pnpm rebuild better-sqlite3` after install. The package looks for `node-v137-darwin-arm64` but only has up to `compiled/24.16.0/`.

2. **REST server `--port` flag** — e2e-plan uses `PORT=5599` env var (correct for Hono). No `--port` CLI flag exists on `dist/serve.js`. Plan correctly uses env var prefix.

3. **`config-env` required build** — Must build `packages/config-env` before CLI/MCP/server. CI does this; plan Step 3 documents it correctly.

4. **MCP inspector `--cli` mode** — Works without browser. Verified: `printf '{"jsonrpc":"2.0","method":"tools/list","id":1}\n' | node packages/mcp/dist/cli.js` returns 18 tools.

---

## Teardown confirmation

- ✅ No background processes remaining (mock-llm killed, REST server killed)
- ✅ All Docker containers stopped and removed (`docker compose down`)
- ✅ Temp dir `/tmp/memstack-qa.HxulRC/` preserved for reference (2.2MB)
- ✅ No git changes, no source edits

---

## Untestable (per plan §7)

| Adapter | Reason |
|---|---|
| PineconeStorageAdapter | Cloud-only, no self-hosted option |
| UpstashStorageAdapter | REST-only, no local emulator |
| Mem0StorageAdapter | `oss` mode needs its own vector/LLM/embedder setup |
| ZepStorageAdapter | `community` mode needs Zep server running |

These remain covered by mocked unit tests only.
