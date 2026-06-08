import type { LLMProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface OllamaLLMConfig {
  /** Ollama server URL. Default: "http://localhost:11434" */
  baseURL?: string;
  /** Default model name. Default: "llama3.2" */
  defaultModel?: string;
  /** Default temperature. Default: 0.7 */
  defaultTemperature?: number;
  /** Default max tokens. Default: 1024 */
  defaultMaxTokens?: number;
}

export class OllamaLLMAdapter implements LLMProvider {
  private baseURL: string;
  private defaultModel: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: OllamaLLMConfig = {}) {
    this.baseURL = config.baseURL ?? "http://localhost:11434";
    this.defaultModel = config.defaultModel ?? "llama3.2";
    this.defaultTemperature = config.defaultTemperature ?? 0.7;
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
    const temperature = request.temperature ?? this.defaultTemperature;
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;

    try {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          options: { temperature, num_predict: maxTokens },
          stream: false,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new MemStackError("LLM_ERROR", `Ollama API error: ${response.status} ${err}`, {
          retryable: response.status >= 500,
        });
      }

      const data = (await response.json()) as {
        message?: { content: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;

      return {
        text: data.message?.content ?? "",
        tokens: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
      };
    } catch (err) {
      if (err instanceof MemStackError) throw err;
      throw new MemStackError("LLM_ERROR", `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }
  }
}
