export const PATCH_PREFIX_SR = "*** Begin Patch\n";
export const PATCH_SUFFIX_SR = "\n*** End Patch";
export const UPDATE_FILE_PREFIX_SR = "*** Update File: ";
const SEARCH_BLOCK_START_REGEX = /^[-]{3,} SEARCH$/;
const SEARCH_BLOCK_END_REGEX = /^[=]{3,}$/;
const REPLACE_BLOCK_END_REGEX = /^[+]{3,} REPLACE$/;

export type SearchReplaceOp = { search: string; replace: string };
export type FileOps = Record<string, Array<SearchReplaceOp>>;

export function parse_search_replace_patch(text: string): FileOps {
  if (!text.startsWith(PATCH_PREFIX_SR) || !text.endsWith(PATCH_SUFFIX_SR)) {
    throw new Error("Patch must start with *** Begin Patch and end with *** End Patch");
  }
  const body = text.slice(PATCH_PREFIX_SR.length, text.length - PATCH_SUFFIX_SR.length);
  const lines = body.split("\n");
  let currentFile: string | null = null;
  let inSearch = false;
  let inReplace = false;
  let searchContent = "";
  let replaceContent = "";
  const ops: FileOps = {};

  for (const line of lines) {
    if (line.startsWith(UPDATE_FILE_PREFIX_SR)) {
      currentFile = line.slice(UPDATE_FILE_PREFIX_SR.length).trim();
      if (!ops[currentFile]) ops[currentFile] = [];
      continue;
    }
    if (!currentFile) {
      continue;
    }
    if (SEARCH_BLOCK_START_REGEX.test(line)) {
      inSearch = true;
      inReplace = false;
      searchContent = "";
      replaceContent = "";
      continue;
    }
    if (SEARCH_BLOCK_END_REGEX.test(line)) {
      inSearch = false;
      inReplace = true;
      continue;
    }
    if (REPLACE_BLOCK_END_REGEX.test(line)) {
      inReplace = false;
      ops[currentFile].push({ search: searchContent, replace: replaceContent });
      searchContent = "";
      replaceContent = "";
      continue;
    }
    if (inSearch) {
      searchContent += line + "\n";
    } else if (inReplace) {
      replaceContent += line + "\n";
    }
  }
  return ops;
}

function line_trimmed_match(original: string, search: string): [number, number] | null {
  const origLines = original.split("\n");
  let searchLines = search.split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  for (let i = 0; i <= origLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (origLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let start = 0;
      for (let k = 0; k < i; k++) start += origLines[k].length + 1;
      let end = start;
      for (let k = 0; k < searchLines.length; k++) end += origLines[i + k].length + 1;
      return [start, end];
    }
  }
  return null;
}

function apply_op(content: string, op: SearchReplaceOp): string {
  const idx = content.indexOf(op.search);
  if (idx !== -1) {
    return content.slice(0, idx) + op.replace + content.slice(idx + op.search.length);
  }
  const trimmed = line_trimmed_match(content, op.search);
  if (trimmed) {
    const [start, end] = trimmed;
    return content.slice(0, start) + op.replace + content.slice(end);
  }
  throw new Error("SEARCH block did not match file content");
}

export function apply_search_replace_patch(text: string, openFn: (p: string) => string, writeFn: (p: string, c: string) => void): string {
  const ops = parse_search_replace_patch(text);
  for (const [file, operations] of Object.entries(ops)) {
    let content = "";
    try {
      content = openFn(file);
    } catch {
      content = "";
    }
    for (const op of operations) {
      content = apply_op(content, op);
    }
    writeFn(file, content);
  }
  return "Done!";
}
