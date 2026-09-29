// Parsing helpers for LLM enrichment output, shared by the client and harness memory.

/**
 * Token cap for enrichment calls. A ceiling, not a target: reasoning models
 * such as deepseek-flash spend tokens thinking before they answer and return
 * an empty reply when the cap is hit first.
 */
export const ENRICHMENT_MAX_TOKENS = 1024;

/** Strip markdown code fences and extract the JSON payload from LLM output. */
export function extractJson(text: string): string {
  let cleaned = text.trim();
  // Remove ```json ... ``` or ``` ... ``` fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return cleaned;
}

/** Parse a JSON array of tags, falling back to comma-separated text. At most `max` tags. */
export function parseTags(text: string, max = 5): string[] {
  try {
    const parsed = JSON.parse(extractJson(text)) as unknown;
    if (Array.isArray(parsed) && parsed.every((t: unknown) => typeof t === "string")) {
      return (parsed as string[]).map((t) => t.toLowerCase().trim()).slice(0, max);
    }
  } catch {
    // Fallback: try comma-separated
  }
  return text
    .split(",")
    .map((t) => t.replace(/[\[\]"]/g, "").trim().toLowerCase())
    .filter((t) => t.length > 0)
    .slice(0, max);
}
