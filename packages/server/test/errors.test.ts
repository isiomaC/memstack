import { describe, expect, it } from "vitest";
import { publicErrorMessage } from "../src/index.js";

describe("REST error responses", () => {
  it("never exposes storage or driver error details to clients", () => {
    expect(publicErrorMessage(new Error("EACCES: /home/private/memstack/data.json"))).toBe("Internal server error");
    expect(publicErrorMessage("driver secret details")).toBe("Internal server error");
  });
});
