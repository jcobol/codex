import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
});

describe("maxTokensForModel override via config", () => {
  it("uses max_context_length from config when present", async () => {
    vi.doMock("../src/utils/config.js", () => ({
      loadConfig: () => ({ maxContextLength: 9999 }),
    }));

    const { maxTokensForModel } = await import("../src/utils/model-utils.js");
    expect(maxTokensForModel("gpt-4o")).toBe(9999);
  });

  it("falls back to defaults when override absent", async () => {
    vi.doMock("../src/utils/config.js", () => ({
      loadConfig: () => ({ }),
    }));

    const { maxTokensForModel } = await import("../src/utils/model-utils.js");
    expect(maxTokensForModel("some-model-32k")).toBe(32000);
  });
});
