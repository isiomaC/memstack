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

// Adapters
export { InMemoryStorage } from "./adapters/storage/memory.js";
export { DiskStorage } from "./adapters/storage/disk.js";
export type { DiskStorageConfig } from "./adapters/storage/disk.js";
export { RedisStorage } from "./adapters/storage/redis.js";
export type { RedisStorageConfig } from "./adapters/storage/redis.js";
export { PostgresStorage } from "./adapters/storage/postgres.js";
export type { PostgresStorageConfig } from "./adapters/storage/postgres.js";
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
