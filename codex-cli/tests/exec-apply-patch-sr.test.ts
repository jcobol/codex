import { execApplyPatchSr } from "../src/utils/agent/exec.js";
import fs from "fs";
import os from "os";
import path from "path";
import { test, expect } from "vitest";

test("execApplyPatchSr creates missing directories when updating a file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-sr-test-"));
  const nestedRel = path.join("foo", "bar", "baz.txt");
  const nestedAbs = path.join(tmpDir, nestedRel);
  const patch = `*** Begin Patch\n*** Update File: ${nestedRel}\n------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE\n*** End Patch`;

  fs.mkdirSync(path.dirname(nestedAbs), { recursive: true });
  fs.writeFileSync(nestedAbs, "old");

  const prev = process.cwd();
  try {
    process.chdir(tmpDir);
    const result = execApplyPatchSr(patch);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  } finally {
    process.chdir(prev);
  }

  const contents = fs.readFileSync(nestedAbs, "utf8");
  expect(contents).toBe("new");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
