import { describe, it, expect } from "vitest";
import { parseToolCallArguments } from "../src/utils/parsers.js";

describe("parseToolCallArguments", () => {
  it("returns error on invalid JSON", () => {
    const result = parseToolCallArguments('{');
    expect(result.ok).toBe(false);
  });

  it("splits simple command strings", () => {
    const json = JSON.stringify({ cmd: "git diff" });
    const result = parseToolCallArguments(json);
    expect(result.ok).toBe(true);
    expect(result.value.cmd).toEqual(["git", "diff"]);
  });

  it("preserves strings with shell operators", () => {
    const json = JSON.stringify({ cmd: "echo hi && ls" });
    const result = parseToolCallArguments(json);
    expect(result.ok).toBe(true);
    expect(result.value.cmd).toEqual(["echo hi && ls"]);
  });
});
