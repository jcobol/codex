export const TOKEN_LOG_ENV_VAR = "CODEX_TOKEN_LOG";

import { appendFileSync } from "fs";
import type { OpenAI } from "openai";

export function recordTokenUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const path = process.env[TOKEN_LOG_ENV_VAR];
  if (!path) return;
  try {
    appendFileSync(path, `${model},${promptTokens},${completionTokens}\n`);
  } catch {
    // ignore write errors
  }
}

export function countPromptTokens(
  messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    }
    const fc = (m as unknown as { function_call?: { name: string; arguments: string } }).function_call;
    if (fc) {
      chars += fc.name.length + fc.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}

export function countTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
