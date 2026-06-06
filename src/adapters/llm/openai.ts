import type { LLMProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface OpenAILLMConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}

export class OpenAILLMAdapter implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;

  constructor(config: OpenAILLMConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.openai.com/v1";
    this.defaultModel = config.defaultModel ?? "gpt-4o-mini";
  }

  async complete(request: {
    system: string;
    user: string;
    model?: string;
  }): Promise<{ text: string; tokens: { prompt: number; completion: number; total: number } }> {
    const model = request.model ?? this.defaultModel;

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new MemStackError("LLM_ERROR", `OpenAI API error: ${response.status} ${err}`, {
          retryable: response.status >= 500,
        });
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      return {
        text: data.choices[0]?.message?.content ?? "",
        tokens: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
          total: data.usage?.total_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError("LLM_ERROR", `LLM request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }
  }
}
