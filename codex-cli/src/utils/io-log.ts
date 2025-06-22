export const IO_LOG_ENV_VAR = "CODEX_IO_LOG";

import { appendFileSync } from "fs";

function log(direction: string, data: unknown): void {
  const path = process.env[IO_LOG_ENV_VAR];
  if (!path) return;
  try {
    const line = JSON.stringify({ direction, data }) + "\n";
    appendFileSync(path, line);
  } catch {
    // ignore write errors
  }
}

export function logInput(data: unknown): void {
  log("input", data);
}

export function logOutput(data: unknown): void {
  log("output", data);
}
