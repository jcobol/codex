import type {
  ExecInput,
  ExecOutputMetadata,
} from "./agent/sandbox/interface.js";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses.mjs";

import { log } from "node:console";
import { formatCommandForDisplay } from "../format-command.js";
import { parse as shellParse } from "shell-quote";

// The console utility import is intentionally explicit to avoid bundlers from
// including the entire `console` module when only the `log` function is
// required.

export function parseToolCallOutput(toolCallOutput: string): {
  output: string;
  metadata: ExecOutputMetadata;
} {
  try {
    const { output, metadata } = JSON.parse(toolCallOutput);
    return {
      output,
      metadata,
    };
  } catch (err) {
    return {
      output: toolCallOutput,
      metadata: {
        exit_code: 1,
        duration_seconds: 0,
      },
    };
  }
}

export type CommandReviewDetails = {
  cmd: Array<string>;
  cmdReadableText: string;
  workdir: string | undefined;
};

/**
 * Tries to parse a tool call and, if successful, returns an object that has
 * both:
 * - an array of strings to use with `ExecInput` and `canAutoApprove()`
 * - a human-readable string to display to the user
 */
export function parseToolCall(
  toolCall: ResponseFunctionToolCall,
): CommandReviewDetails | undefined {
  const result = parseToolCallArguments(toolCall.arguments);
  if (!result.ok) {
    return undefined;
  }

  const { cmd, workdir } = result.value;
  const cmdReadableText = formatCommandForDisplay(cmd);

  return {
    cmd,
    cmdReadableText,
    workdir,
  };
}

/**
 * If toolCallArguments is a string of JSON that can be parsed into an object
 * with a "cmd" or "command" property that is an `Array<string>`, then returns
 * that array. Otherwise, returns undefined.
 */
export type ParseToolCallArgumentsResult =
  | { ok: true; value: ExecInput }
  | { ok: false; error: string };

export function parseToolCallArguments(
  toolCallArguments: string,
): ParseToolCallArgumentsResult {
  let json: unknown;
  try {
    json = JSON.parse(toolCallArguments);
  } catch (err) {
    log(`Failed to parse toolCall.arguments: ${toolCallArguments}`);
    return { ok: false, error: String(err) };
  }

  if (typeof json !== "object" || json == null) {
    return { ok: false, error: "arguments not an object" };
  }

  const { cmd, command } = json as Record<string, unknown>;
  // The OpenAI model sometimes produces a single string instead of an array.
  // Accept both shapes:
  const commandArray =
    toStringArray(cmd) ??
    toStringArray(command) ??
    (typeof cmd === "string" ? maybeSplitString(cmd) : undefined) ??
    (typeof command === "string" ? maybeSplitString(command) : undefined);
  if (commandArray == null) {
    return { ok: false, error: "missing command" };
  }

  // @ts-expect-error timeout and workdir may not exist on json.
  const { timeout, workdir } = json;
  return {
    ok: true,
    value: {
      cmd: commandArray,
      workdir: typeof workdir === "string" ? workdir : undefined,
      timeoutInMillis: typeof timeout === "number" ? timeout : undefined,
    },
  };
}

function toStringArray(obj: unknown): Array<string> | undefined {
  if (Array.isArray(obj) && obj.every((item) => typeof item === "string")) {
    const arrayOfStrings: Array<string> = obj;
    return arrayOfStrings;
  } else {
    return undefined;
  }
}

function maybeSplitString(command: string): Array<string> {
  try {
    const parsed = shellParse(command);
    if (parsed.every((p) => typeof p === "string")) {
      return parsed as Array<string>;
    }
  } catch {
    /* ignore */
  }
  return [command];
}

export function parseApplyPatchArguments(
  toolCallArguments: string,
): { patch: string; workdir?: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(toolCallArguments);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json == null) {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  let patch: string | undefined;
  if (typeof obj["patch"] === "string") {
    patch = obj["patch"] as string;
  } else if (typeof obj["body"] === "string") {
    patch = obj["body"] as string;
  } else if (typeof obj["*body"] === "string") {
    patch = obj["*body"] as string;
  } else if (Array.isArray(obj["cmd"])) {
    const arr = (obj["cmd"] as Array<unknown>).filter(
      (v) => typeof v === "string",
    ) as Array<string>;
    if (arr.length === 1) {
      patch = arr[0];
    } else if (arr.length >= 2 && arr[0] === "apply_patch") {
      patch = arr.slice(1).join("\n");
    }
  } else if (typeof obj["cmd"] === "string") {
    patch = obj["cmd"] as string;
  }
  if (typeof patch !== "string") {
    return undefined;
  }
  const workdir =
    typeof obj["workdir"] === "string" ? (obj["workdir"] as string) : undefined;
  return { patch, workdir };
}
