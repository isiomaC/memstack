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
export { OpenAILLMAdapter } from "./adapters/llm/openai.js";
export type { OpenAILLMConfig } from "./adapters/llm/openai.js";
export { AnthropicLLMAdapter } from "./adapters/llm/anthropic.js";
export type { AnthropicLLMConfig } from "./adapters/llm/anthropic.js";
export { OpenAIEmbeddingAdapter } from "./adapters/embedding/openai.js";
export type { OpenAIEmbeddingConfig } from "./adapters/embedding/openai.js";
