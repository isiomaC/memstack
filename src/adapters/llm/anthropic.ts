import type { LLMProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface AnthropicLLMConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
}

export class AnthropicLLMAdapter implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;
  private defaultMaxTokens: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sdk: any;

  constructor(config: AnthropicLLMConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.anthropic.com";
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-5-20250929";
    this.defaultMaxTokens = config.defaultMaxTokens ?? 1024;
  }

  async complete(request: {
    system: string;
    user: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number; total: number } }> {
    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;

    try {
      if (!this.sdk) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        this.sdk = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
      }

      const response = await this.sdk.messages.create({
        model,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        max_tokens: maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });

      const text = response.content.length > 0 && "text" in response.content[0]
        ? (response.content[0] as { text: string }).text
        : "";

      return {
        text,
        tokens: {
          prompt: response.usage?.input_tokens ?? 0,
          completion: response.usage?.output_tokens ?? 0,
          total: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
        },
      };
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError("LLM_ERROR", `Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }
  }
}
