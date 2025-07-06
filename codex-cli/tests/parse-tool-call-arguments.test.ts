import { describe, it, expect } from "vitest";
import { parseToolCallArguments } from "../src/utils/parsers.js";

describe("parseToolCallArguments", () => {
  it("returns error on invalid JSON", () => {
    const result = parseToolCallArguments('{');
    expect(result.ok).toBe(false);
  });
});
