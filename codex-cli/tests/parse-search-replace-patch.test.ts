import { parse_search_replace_patch, apply_search_replace_patch } from "../src/utils/agent/apply-patch-sr.js";
import { expect, test, describe } from "vitest";

function createInMemoryFS(initialFiles: Record<string, string>) {
  const files: Record<string, string> = { ...initialFiles };
  return {
    openFn: (p: string) => {
      if (!(p in files)) throw new Error("file not found");
      return files[p];
    },
    writeFn: (p: string, c: string) => {
      files[p] = c;
    },
    files,
  };
}

describe("search/replace patch", () => {
  test("parse_search_replace_patch parses operations", () => {
    const patch = `*** Begin Patch\n*** Update File: a.txt\n------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE\n*** End Patch`;
    expect(parse_search_replace_patch(patch)).toEqual({
      "a.txt": [
        { search: "old\n", replace: "new\n" },
      ],
    });
  });

  test("apply_search_replace_patch updates file contents", () => {
    const patch = `*** Begin Patch\n*** Update File: f.txt\n------- SEARCH\nhello\n=======\nbye\n+++++++ REPLACE\n*** End Patch`;
    const fs = createInMemoryFS({ "f.txt": "say hello" });
    apply_search_replace_patch(patch, fs.openFn, fs.writeFn);
    expect(fs.files["f.txt"]).toBe("say bye");
  });
});
