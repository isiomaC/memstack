import type { LLMProvider } from "../../interfaces.js";
import { MemStackError } from "../../errors.js";

export interface GroqLLMConfig {
  /** Groq API key */
  apiKey: string;
  /** Base URL. Default: "https://api.groq.com/openai/v1" */
  baseURL?: string;
  /** Default model. Default: "llama-3.3-70b-versatile" */
  defaultModel?: string;
  /** Default temperature. Default: 0.7 */
  defaultTemperature?: number;
  /** Default max tokens. Default: 1024 */
  defaultMaxTokens?: number;
}

export class GroqLLMAdapter implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: GroqLLMConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? "https://api.groq.com/openai/v1";
    this.defaultModel = config.defaultModel ?? "llama-3.3-70b-versatile";
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
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new MemStackError("LLM_ERROR", `Groq API error: ${response.status} ${err}`, {
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
      throw new MemStackError("LLM_ERROR", `Groq request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }
  }

  async *completeStream(request: {
    system: string;
    user: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): AsyncIterable<{ text: string; tokens: { prompt: number; completion: number; total: number } }> {
    const model = request.model ?? this.defaultModel;
    const temperature = request.temperature ?? this.defaultTemperature;
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;

    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
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
          temperature,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (err) {
      throw new MemStackError("LLM_ERROR", `Groq streaming request failed: ${err instanceof Error ? err.message : String(err)}`, {
        retryable: true,
      });
    }

    if (!response.ok) {
      const err = await response.text();
      throw new MemStackError("LLM_ERROR", `Groq streaming error: ${response.status} ${err}`, {
        retryable: response.status >= 500,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new MemStackError("LLM_ERROR", "No response body for streaming");

    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
              x_groq?: { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
            };

            const content = parsed.choices?.[0]?.delta?.content ?? "";
            const usage = parsed.usage ?? parsed.x_groq?.usage;
            if (usage) {
              promptTokens = usage.prompt_tokens;
              completionTokens = usage.completion_tokens;
            }

            if (content) {
              yield {
                text: content,
                tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
              };
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
