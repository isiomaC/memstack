# MemStack — TODO

## v0.2 (next)

- [x] **Disk storage adapter** — `DiskStorage` using local filesystem (JSON files per actor)
- [x] **Ollama LLM adapter** — built-in, not just docs example
- [x] **auto-importance** — LLM-based importance scoring on `store()` when `importance` not provided
- [x] **auto-tagging** — LLM-based tag extraction on `store()` when `tags` not provided
- [x] **token-aware `compileContext()`** — respect `maxTokens` by truncating, not just estimating
- [x] **`onConflict: "append"` mode** — deduplicate by content hash, append to existing memory instead of duplicate

## v0.3

- [ ] **`@memstack/relationships`** — entity relationship tracking as separate package
- [x] **Redis storage adapter**
- [x] **Postgres storage adapter** (pgvector for embeddings)
- [x] **Cohere embedding adapter**
- [x] **Groq LLM adapter**

## v1.0

- [ ] **Benchmarks** — pub/sub vs Mem0 on retrieval quality, latency, cost
- [x] **Streaming `complete()` support** in LLMProvider interface
- [x] **Custom summarization prompt** API (expose in `MemStackConfig`, not just Summarizer constructor)
- [ ] **Migration guide** — Mem0 → MemStack migration doc
- [ ] **Python port** — `pip install memstack`
