import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recordTokenUsage, countPromptTokens, countTextTokens } from "../src/utils/token-metering.js";

import type { OpenAI } from "openai";

// Basic smoke tests for token metering utilities

test("recordTokenUsage appends to file", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
  const file = join(dir, "log.csv");
  process.env["CODEX_TOKEN_LOG"] = file;
  recordTokenUsage("model", 1, 2);
  const content = readFileSync(file, "utf8").trim();
  expect(content).toBe("model,1,2");
});

test("count helpers estimate tokens", () => {
  const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      function_call: { name: "fn", arguments: "abc" },
    },
  ];
  const p = countPromptTokens(messages);
  expect(p).toBeGreaterThan(0);
  expect(countTextTokens("hello")).toBe(2);
});
