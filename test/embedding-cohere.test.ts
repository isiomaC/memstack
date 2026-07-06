import { describe, it, expect, vi, afterEach } from "vitest";
import { CohereEmbeddingAdapter } from "../src/adapters/embedding/cohere.js";
import { MemStackError } from "../src/errors.js";

describe("CohereEmbeddingAdapter", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns [] without calling fetch for an empty input", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    expect(await adapter.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /embed with search_document input_type and float embedding type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: { float: [[0.1, 0.2], [0.3, 0.4]] } }),
    });
    global.fetch = fetchMock as never;

    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    const result = await adapter.embed(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cohere.ai/v1/embed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer co-test" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      model: "embed-english-v3.0",
      texts: ["a", "b"],
      input_type: "search_document",
      embedding_types: ["float"],
    });
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it("resolves known model dimensions and falls back to 1024 for unknown models", () => {
    expect(new CohereEmbeddingAdapter({ apiKey: "k" }).dimensions).toBe(1024);
    expect(new CohereEmbeddingAdapter({ apiKey: "k", model: "embed-english-light-v3.0" }).dimensions).toBe(384);
    expect(new CohereEmbeddingAdapter({ apiKey: "k", model: "embed-english-v2.0" }).dimensions).toBe(4096);
    expect(new CohereEmbeddingAdapter({ apiKey: "k", model: "some-future-model" }).dimensions).toBe(1024);
  });

  it("rejects batches over maxBatchSize (96) without calling fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    const tooMany = Array.from({ length: 97 }, (_, i) => `text-${i}`);

    await expect(adapter.embed(tooMany)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when the API responds without a float field", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: {} }),
    }) as never;
    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    expect(await adapter.embed(["a"])).toEqual([]);
  });

  it("throws a retryable MemStackError on 5xx responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "overloaded",
    }) as never;

    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    await expect(adapter.embed(["x"])).rejects.toMatchObject({ code: "EMBEDDING_ERROR", retryable: true });
  });

  it("wraps network failures in a retryable MemStackError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("timeout")) as never;
    const adapter = new CohereEmbeddingAdapter({ apiKey: "co-test" });
    await expect(adapter.embed(["x"])).rejects.toBeInstanceOf(MemStackError);
  });
});
