import { describe, it, expect } from "vitest";
import { parseApplyPatchArguments } from "../src/utils/parsers.js";

describe("parseApplyPatchArguments", () => {
  it("handles patch field", () => {
    const patch = "*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch";
    const args = parseApplyPatchArguments(JSON.stringify({ patch }));
    expect(args).toEqual({ patch, workdir: undefined });
  });

  it("handles cmd array with apply_patch", () => {
    const patch = "*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch";
    const args = parseApplyPatchArguments(JSON.stringify({
      cmd: ["apply_patch", patch],
      workdir: "/tmp",
    }));
    expect(args).toEqual({ patch, workdir: "/tmp" });
  });

  it("handles body fields", () => {
    const patch = "*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch";
    const args1 = parseApplyPatchArguments(JSON.stringify({ body: patch }));
    expect(args1).toEqual({ patch, workdir: undefined });
    const args2 = parseApplyPatchArguments(JSON.stringify({ "*body": patch }));
    expect(args2).toEqual({ patch, workdir: undefined });
  });
});
