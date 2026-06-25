import type { EmbeddingProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface CohereEmbeddingConfig {
  /** Cohere API key */
  apiKey: string;
  /** Model name. Default: "embed-english-v3.0" (1024 dims) */
  model?: string;
  /** Base URL. Default: "https://api.cohere.ai/v1" */
  baseURL?: string;
}

const DIMENSIONS: Record<string, number> = {
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "embed-english-light-v3.0": 384,
  "embed-multilingual-light-v3.0": 384,
  "embed-english-v2.0": 4096,
  "embed-multilingual-v2.0": 768,
};

export class CohereEmbeddingAdapter implements EmbeddingProvider {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 96;

  constructor(config: CohereEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.cohere.ai/v1";
    this.model = config.model ?? "embed-english-v3.0";
    this.dimensions = DIMENSIONS[this.model] ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > 96) {
      throw new MemStackError("VALIDATION_ERROR", `Cohere max 96 texts per batch, got ${texts.length}`);
    }

    try {
      const response = await fetch(`${this.baseURL}/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          texts,
          input_type: "search_document",
          embedding_types: ["float"],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new MemStackError("EMBEDDING_ERROR", `Cohere Embedding error: ${response.status} ${err}`, {
          retryable: response.status >= 500,
        });
      }

      const data = (await response.json()) as {
        embeddings: { float?: number[][] };
      };

      return data.embeddings?.float ?? [];
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError(
        "EMBEDDING_ERROR",
        `Cohere embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true }
      );
    }
  }
}
