# MemStack — TODO

## v0.2 (next)

- [ ] **Disk storage adapter** — `DiskStorage` using local filesystem (JSON files per actor)
- [ ] **Ollama LLM adapter** — built-in, not just docs example
- [ ] **auto-importance** — LLM-based importance scoring on `store()` when `importance` not provided
- [ ] **auto-tagging** — LLM-based tag extraction on `store()` when `tags` not provided
- [ ] **token-aware `compileContext()`** — respect `maxTokens` by truncating, not just estimating
- [ ] **`onConflict: "append"` mode** — deduplicate by content hash, append to existing memory instead of duplicate

## v0.3

- [ ] **`@memstack/relationships`** — entity relationship tracking as separate package
- [ ] **Redis storage adapter**
- [ ] **Postgres storage adapter** (pgvector for embeddings)
- [ ] **Cohere embedding adapter**
- [ ] **Groq LLM adapter**

## v1.0

- [ ] **Benchmarks** — pub/sub vs Mem0 on retrieval quality, latency, cost
- [ ] **Streaming `complete()` support** in LLMProvider interface
- [ ] **Custom summarization prompt** API (expose in `MemStackConfig`, not just Summarizer constructor)
- [ ] **Migration guide** — Mem0 → MemStack migration doc
- [ ] **Python port** — `pip install memstack`
