// Main client
export { MemStack } from "./client.js";

// Types
export type {
  Memory,
  MemoryType,
  CompiledContext,
  ProcessResult,
  MemStackSnapshot,
  HealthStatus,
  MemoryStats,
} from "./types.js";

// Interfaces
export type {
  MemoryStoreInput,
  MemoryRetrieveQuery,
  MemoryCountFilter,
  ContextOptions,
  SummarizeOptions,
  PruneStrategy,
  LLMProvider,
  EmbeddingProvider,
  StorageProvider,
  MemStackConfig,
  ProcessInput,
} from "./interfaces.js";

// Errors
export { MemStackError, notFound, validationError, storageError, configError } from "./errors.js";
export type { MemStackErrorCode } from "./errors.js";

// Storage Adapters — Production-ready (e2e verified)
export { InMemoryStorageAdapter } from "./adapters/storage/memory.js";
export { DiskStorageAdapter } from "./adapters/storage/disk.js";
export type { DiskStorageConfig } from "./adapters/storage/disk.js";
export { MarkdownStorageAdapter } from "./adapters/storage/markdown.js";
export type { MarkdownStorageConfig } from "./adapters/storage/markdown.js";
export { HybridStorageAdapter } from "./adapters/storage/hybrid.js";
export type { HybridStorageConfig } from "./adapters/storage/hybrid.js";
export { PostgresStorageAdapter } from "./adapters/storage/postgres.js";
export type { PostgresStorageConfig } from "./adapters/storage/postgres.js";
export { RedisStorageAdapter } from "./adapters/storage/redis.js";
export type { RedisStorageConfig } from "./adapters/storage/redis.js";
export { QdrantStorageAdapter } from "./adapters/storage/qdrant.js";
export type { QdrantStorageConfig } from "./adapters/storage/qdrant.js";
export { Neo4jStorageAdapter } from "./adapters/storage/neo4j.js";
export type { Neo4jStorageConfig } from "./adapters/storage/neo4j.js";
export { WeaviateStorageAdapter } from "./adapters/storage/weaviate.js";
export type { WeaviateStorageConfig } from "./adapters/storage/weaviate.js";
export { LanceDBStorageAdapter } from "./adapters/storage/lancedb.js";
export type { LanceDBStorageConfig } from "./adapters/storage/lancedb.js";
export { MongoDBStorageAdapter } from "./adapters/storage/mongodb.js";
export type { MongoDBStorageConfig } from "./adapters/storage/mongodb.js";

// Storage Adapters — Experimental (mock-tested, e2e blocked by platform constraints)
// export { SQLiteStorageAdapter } from "./adapters/storage/sqlite.js";
// export type { SQLiteStorageConfig } from "./adapters/storage/sqlite.js";
// export { ChromaStorageAdapter } from "./adapters/storage/chroma.js";
// export type { ChromaStorageConfig } from "./adapters/storage/chroma.js";
// export { PineconeStorageAdapter } from "./adapters/storage/pinecone.js";
// export type { PineconeStorageConfig } from "./adapters/storage/pinecone.js";
// export { TursoStorageAdapter } from "./adapters/storage/turso.js";
// export type { TursoStorageConfig } from "./adapters/storage/turso.js";
// export { ZepStorageAdapter } from "./adapters/storage/zep.js";
// export type { ZepStorageConfig } from "./adapters/storage/zep.js";
// export { Mem0StorageAdapter } from "./adapters/storage/mem0.js";
// export type { Mem0StorageConfig } from "./adapters/storage/mem0.js";
// export { UpstashStorageAdapter } from "./adapters/storage/upstash.js";
// export type { UpstashStorageConfig } from "./adapters/storage/upstash.js";
export { OpenAILLMAdapter } from "./adapters/llm/openai.js";
export type { OpenAILLMConfig } from "./adapters/llm/openai.js";
export { AnthropicLLMAdapter } from "./adapters/llm/anthropic.js";
export type { AnthropicLLMConfig } from "./adapters/llm/anthropic.js";
export { OpenAIEmbeddingAdapter } from "./adapters/embedding/openai.js";
export type { OpenAIEmbeddingConfig } from "./adapters/embedding/openai.js";
export { CohereEmbeddingAdapter } from "./adapters/embedding/cohere.js";
export type { CohereEmbeddingConfig } from "./adapters/embedding/cohere.js";
export { OllamaLLMAdapter } from "./adapters/llm/ollama.js";
export type { OllamaLLMConfig } from "./adapters/llm/ollama.js";
export { GroqLLMAdapter } from "./adapters/llm/groq.js";
export type { GroqLLMConfig } from "./adapters/llm/groq.js";
