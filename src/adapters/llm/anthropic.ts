import type { LLMProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface AnthropicLLMConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}

export class AnthropicLLMAdapter implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sdk: any;

  constructor(config: AnthropicLLMConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.anthropic.com";
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-5-20250929";
  }

  async complete(request: {
    system: string;
    user: string;
    model?: string;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number; total: number } }> {
    const model = request.model ?? this.defaultModel;

    try {
      if (!this.sdk) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        this.sdk = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
      }

      const response = await this.sdk.messages.create({
        model,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        max_tokens: 1024,
      });

      const text = response.content[0]?.text ?? "";
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
