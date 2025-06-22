import { test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logInput, logOutput, IO_LOG_ENV_VAR } from "../src/utils/io-log.js";

test("logInput/logOutput append to file", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
  const file = join(dir, "io.log");
  process.env[IO_LOG_ENV_VAR] = file;
  logInput({ msg: "hi" });
  logOutput({ msg: "bye" });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toContain("input");
  expect(lines[1]).toContain("output");
});
