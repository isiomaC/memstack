import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIEmbeddingAdapter } from "../src/adapters/embedding/openai.js";
import { MemStackError } from "../src/errors.js";

describe("OpenAIEmbeddingAdapter", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns [] without calling fetch for an empty input", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    expect(await adapter.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /embeddings and re-sorts results by index", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.2, 0.2], index: 1 },
          { embedding: [0.1, 0.1], index: 0 },
        ],
      }),
    });
    global.fetch = fetchMock as never;

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    const result = await adapter.embed(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
    expect(result).toEqual([[0.1, 0.1], [0.2, 0.2]]);
  });

  it("defaults to 1536 dims for text-embedding-3-small and 3072 for -large", () => {
    expect(new OpenAIEmbeddingAdapter({ apiKey: "k" }).dimensions).toBe(1536);
    expect(new OpenAIEmbeddingAdapter({ apiKey: "k", model: "text-embedding-3-large" }).dimensions).toBe(3072);
  });

  it("rejects batches over maxBatchSize without calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    const tooMany = Array.from({ length: 2049 }, (_, i) => `text-${i}`);

    await expect(adapter.embed(tooMany)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a retryable MemStackError on 5xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "overloaded",
    }) as never;

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    await expect(adapter.embed(["x"])).rejects.toMatchObject({ code: "EMBEDDING_ERROR", retryable: true });
  });

  it("throws a non-retryable MemStackError on 4xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request",
    }) as never;

    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    await expect(adapter.embed(["x"])).rejects.toMatchObject({ code: "EMBEDDING_ERROR", retryable: false });
  });

  it("wraps network failures in a retryable MemStackError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout")) as never;
    const adapter = new OpenAIEmbeddingAdapter({ apiKey: "sk-test" });
    await expect(adapter.embed(["x"])).rejects.toBeInstanceOf(MemStackError);
    await expect(adapter.embed(["x"])).rejects.toMatchObject({ retryable: true });
  });
});
