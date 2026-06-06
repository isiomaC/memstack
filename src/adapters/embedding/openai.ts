import type { EmbeddingProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export class OpenAIEmbeddingAdapter implements EmbeddingProvider {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  readonly dimensions: number;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.openai.com/v1";
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = this.model === "text-embedding-3-large" ? 3072 : 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > 2048) {
      throw new MemStackError("VALIDATION_ERROR", `Max 2048 texts per batch, got ${texts.length}`);
    }

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new MemStackError("EMBEDDING_ERROR", `OpenAI Embedding error: ${response.status} ${err}`, {
          retryable: response.status >= 500,
        });
      }

      const data = (await response.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      return data.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError(
        "EMBEDDING_ERROR",
        `Embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true }
      );
    }
  }
}
