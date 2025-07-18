import type { ReviewDecision } from "./review.js";
import type { ApplyPatchCommand, ApprovalPolicy } from "../../approvals.js";
import type { AppConfig } from "../config.js";
import type { ResponseEvent } from "../responses.js";
import type {
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseItem,
  ResponseCreateParams,
  FunctionTool,
  Tool,
} from "openai/resources/responses/responses.mjs";
import type { Reasoning } from "openai/resources.mjs";

import { CLI_VERSION } from "../../version.js";
import {
  OPENAI_TIMEOUT_MS,
  OPENAI_ORGANIZATION,
  OPENAI_PROJECT,
  getBaseUrl,
  AZURE_OPENAI_API_VERSION,
} from "../config.js";
import { log } from "../logger/log.js";
import { parseToolCallArguments, parseApplyPatchArguments } from "../parsers.js";
import { getEnvironmentInfo } from "../platform-info.js";
import { responsesCreateViaChatCompletions } from "../responses.js";
import {
  ORIGIN,
  getSessionId,
  setCurrentModel,
  setSessionId,
} from "../session.js";
import { applyPatchToolInstructions } from "./apply-patch.js";
import { handleExecCommand } from "./handle-exec-command.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import OpenAI, { APIConnectionTimeoutError, AzureOpenAI } from "openai";
import os from "os";
import fs from "fs";

// Wait time before retrying after rate limit errors (ms).
const RATE_LIMIT_RETRY_WAIT_MS = parseInt(
  process.env["OPENAI_RATE_LIMIT_RETRY_WAIT_MS"] || "500",
  10,
);

// See https://github.com/openai/openai-node/tree/v4?tab=readme-ov-file#configuring-an-https-agent-eg-for-proxies
const PROXY_URL = process.env["HTTPS_PROXY"];

export type CommandConfirmation = {
  review: ReviewDecision;
  applyPatch?: ApplyPatchCommand | undefined;
  customDenyMessage?: string;
  explanation?: string;
};

const alreadyProcessedResponses = new Set();
const alreadyStagedItemIds = new Set<string>();

type AgentLoopParams = {
  model: string;
  provider?: string;
  config?: AppConfig;
  instructions?: string;
  approvalPolicy: ApprovalPolicy;
  /**
   * Whether the model responses should be stored on the server side (allows
   * using `previous_response_id` to provide conversational context). Defaults
   * to `true` to preserve the current behaviour. When set to `false` the agent
   * will instead send the *full* conversation context as the `input` payload
   * on every request and omit the `previous_response_id` parameter.
   */
  disableResponseStorage?: boolean;
  onItem: (item: ResponseItem) => void;
  onLoading: (loading: boolean) => void;

  /** Extra writable roots to use with sandbox execution. */
  additionalWritableRoots: ReadonlyArray<string>;

  /** Called when the command is not auto-approved to request explicit user review. */
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>;
  onLastResponseId: (lastResponseId: string) => void;
  /**
   * Optional hook used for quiet/json modes to emit the final serialized
   * response once the task has concluded.
   */
  sendResponse?: (payload: string) => void;
  /** Optional object that will be serialized as the final JSON result. */
  jsonResponse?: {
    status?: string;
    analysis?: string;
    file_structure?: string;
  };
};

const shellFunctionTool: FunctionTool = {
  type: "function",
  name: "shell",
  description: "Runs a shell command, and returns its output.",
  strict: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "array", items: { type: "string" } },
      workdir: {
        type: "string",
        description: "The working directory for the command.",
      },
      timeout: {
        type: "number",
        description:
          "The maximum time to wait for the command to complete in milliseconds.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const localShellTool: Tool = {
  //@ts-expect-error - waiting on sdk
  type: "local_shell",
};

const continueTool: FunctionTool = {
  type: "function",
  name: "continue",
  description: "Request another planning step before responding.",
  strict: false,
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const lastResponseTool: FunctionTool = {
  type: "function",
  name: "last_response",
  description:
    "Indicates the model has completed its task and no further turns are required.",
  strict: false,
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export class AgentLoop {
  private model: string;
  private provider: string;
  private instructions?: string;
  private approvalPolicy: ApprovalPolicy;
  private config: AppConfig;
  private additionalWritableRoots: ReadonlyArray<string>;
  /** Whether we ask the API to persist conversation state on the server */
  private readonly disableResponseStorage: boolean;

  // Using `InstanceType<typeof OpenAI>` sidesteps typing issues with the OpenAI package under
  // the TS 5+ `moduleResolution=bundler` setup. OpenAI client instance. We keep the concrete
  // type to avoid sprinkling `any` across the implementation while still allowing paths where
  // the OpenAI SDK types may not perfectly match. The `typeof OpenAI` pattern captures the
  // instance shape without resorting to `any`.
  private oai: OpenAI;

  private onItem: (item: ResponseItem) => void;
  private onLoading: (loading: boolean) => void;
  private getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>;
  private onLastResponseId: (lastResponseId: string) => void;
  private sendResponse: (payload: string) => void;
  public jsonResponse?: {
    status?: string;
    analysis?: string;
    file_structure?: string;
  };

  /**
   * A reference to the currently active stream returned from the OpenAI
   * client. We keep this so that we can abort the request if the user decides
   * to interrupt the current task (e.g. via the escape hot‑key).
   */
  private currentStream: unknown | null = null;
  /** Incremented with every call to `run()`. Allows us to ignore stray events
   * from streams that belong to a previous run which might still be emitting
   * after the user has canceled and issued a new command. */
  private generation = 0;
  /** AbortController for in‑progress tool calls (e.g. shell commands). */
  private execAbortController: AbortController | null = null;
  /** Set to true when `cancel()` is called so `run()` can exit early. */
  private canceled = false;

  /**
   * Local conversation transcript used when `disableResponseStorage === true`. Holds
   * all non‑system items exchanged so far so we can provide full context on
   * every request.
   */
  private transcript: Array<ResponseInputItem> = [];
  /** Function calls that were emitted by the model but never answered because
   *  the user cancelled the run.  We keep the `call_id`s around so the *next*
   *  request can send a dummy `function_call_output` that satisfies the
   *  contract and prevents the
   *    400 | No tool output found for function call …
   *  error from OpenAI. */
  private pendingAborts: Set<string> = new Set();
  /** When set the current run will end after processing the present turn. */
  private stopAfterCurrentTurn = false;
  /** Set to true by `terminate()` – prevents any further use of the instance. */
  private terminated = false;
  /** Master abort controller – fires when terminate() is invoked. */
  private readonly hardAbort = new AbortController();

  /**
   * Abort the ongoing request/stream, if any. This allows callers (typically
   * the UI layer) to interrupt the current agent step so the user can issue
   * new instructions without waiting for the model to finish.
   */
  public cancel(): void {
    if (this.terminated) {
      return;
    }

    // Reset the current stream to allow new requests
    this.currentStream = null;
    log(
      `AgentLoop.cancel() invoked – currentStream=${Boolean(
        this.currentStream,
      )} execAbortController=${Boolean(this.execAbortController)} generation=${
        this.generation
      }`,
    );
    (
      this.currentStream as { controller?: { abort?: () => void } } | null
    )?.controller?.abort?.();

    this.canceled = true;

    // Abort any in-progress tool calls
    this.execAbortController?.abort();

    // Create a new abort controller for future tool calls
    this.execAbortController = new AbortController();
    log("AgentLoop.cancel(): execAbortController.abort() called");

    // NOTE: We intentionally do *not* clear `lastResponseId` here.  If the
    // stream produced a `function_call` before the user cancelled, OpenAI now
    // expects a corresponding `function_call_output` that must reference that
    // very same response ID.  We therefore keep the ID around so the
    // follow‑up request can still satisfy the contract.

    // If we have *not* seen any function_call IDs yet there is nothing that
    // needs to be satisfied in a follow‑up request.  In that case we clear
    // the stored lastResponseId so a subsequent run starts a clean turn.
    if (this.pendingAborts.size === 0) {
      try {
        this.onLastResponseId("");
      } catch {
        /* ignore */
      }
    }

    this.onLoading(false);

    /* Inform the UI that the run was aborted by the user. */
    // const cancelNotice: ResponseItem = {
    //   id: `cancel-${Date.now()}`,
    //   type: "message",
    //   role: "system",
    //   content: [
    //     {
    //       type: "input_text",
    //       text: "⏹️  Execution canceled by user.",
    //     },
    //   ],
    // };
    // this.onItem(cancelNotice);

    this.generation += 1;
    log(`AgentLoop.cancel(): generation bumped to ${this.generation}`);
  }

  /**
   * Hard‑stop the agent loop. After calling this method the instance becomes
   * unusable: any in‑flight operations are aborted and subsequent invocations
   * of `run()` will throw.
   */
  public terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;

    this.hardAbort.abort();

    this.cancel();
  }

  public sessionId: string;
  /*
   * Cumulative thinking time across this AgentLoop instance (ms).
   * Currently not used anywhere – comment out to keep the strict compiler
   * happy under `noUnusedLocals`.  Restore when telemetry support lands.
   */
  // private cumulativeThinkingMs = 0;
  constructor({
    model,
    provider = "openai",
    instructions,
    approvalPolicy,
    disableResponseStorage,
    // `config` used to be required.  Some unit‑tests (and potentially other
    // callers) instantiate `AgentLoop` without passing it, so we make it
    // optional and fall back to sensible defaults.  This keeps the public
    // surface backwards‑compatible and prevents runtime errors like
    // "Cannot read properties of undefined (reading 'apiKey')" when accessing
    // `config.apiKey` below.
    config,
    onItem,
    onLoading,
    getCommandConfirmation,
    onLastResponseId,
    additionalWritableRoots,
    sendResponse,
    jsonResponse,
  }: AgentLoopParams & { config?: AppConfig }) {
    this.model = model;
    this.provider = provider;
    this.instructions = instructions;
    this.approvalPolicy = approvalPolicy;

    // If no `config` has been provided we derive a minimal stub so that the
    // rest of the implementation can rely on `this.config` always being a
    // defined object.  We purposefully copy over the `model` and
    // `instructions` that have already been passed explicitly so that
    // downstream consumers (e.g. telemetry) still observe the correct values.
    this.config = config ?? {
      model,
      instructions: instructions ?? "",
    };
    this.additionalWritableRoots = additionalWritableRoots;
    this.onItem = onItem;
    this.onLoading = onLoading;
    this.getCommandConfirmation = getCommandConfirmation;
    this.onLastResponseId = onLastResponseId;
    this.sendResponse = sendResponse ?? (() => {});
    this.jsonResponse = jsonResponse;

    this.disableResponseStorage = disableResponseStorage ?? false;
    this.sessionId = getSessionId() || randomUUID().replaceAll("-", "");
    // Configure OpenAI client with optional timeout (ms) from environment
    const timeoutMs = OPENAI_TIMEOUT_MS;
    const apiKey = this.config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    const baseURL = getBaseUrl(this.provider);

    this.oai = new OpenAI({
      // The OpenAI JS SDK only requires `apiKey` when making requests against
      // the official API.  When running unit‑tests we stub out all network
      // calls so an undefined key is perfectly fine.  We therefore only set
      // the property if we actually have a value to avoid triggering runtime
      // errors inside the SDK (it validates that `apiKey` is a non‑empty
      // string when the field is present).
      ...(apiKey ? { apiKey } : {}),
      baseURL,
      defaultHeaders: {
        originator: ORIGIN,
        version: CLI_VERSION,
        session_id: this.sessionId,
        ...(OPENAI_ORGANIZATION
          ? { "OpenAI-Organization": OPENAI_ORGANIZATION }
          : {}),
        ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
      },
      httpAgent: PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });

    if (this.provider.toLowerCase() === "azure") {
      this.oai = new AzureOpenAI({
        apiKey,
        baseURL,
        apiVersion: AZURE_OPENAI_API_VERSION,
        defaultHeaders: {
          originator: ORIGIN,
          version: CLI_VERSION,
          session_id: this.sessionId,
          ...(OPENAI_ORGANIZATION
            ? { "OpenAI-Organization": OPENAI_ORGANIZATION }
            : {}),
          ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
        },
        httpAgent: PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
    }

    setSessionId(this.sessionId);
    setCurrentModel(this.model);

    this.hardAbort = new AbortController();

    this.hardAbort.signal.addEventListener(
      "abort",
      () => this.execAbortController?.abort(),
      { once: true },
    );
  }

  private stripInternalFields(item: ResponseInputItem): ResponseInputItem {
    const clean = { ...item } as Record<string, unknown>;
    delete clean["duration_ms"];
    delete clean["id"];
    delete clean["status"];
    return clean as unknown as ResponseInputItem;
  }

  private isRateLimitError(e: unknown): boolean {
    if (!e || typeof e !== "object") {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ex: any = e;
    return (
      ex.status === 429 ||
      ex.code === "rate_limit_exceeded" ||
      ex.type === "rate_limit_exceeded"
    );
  }

  private isNetworkOrServerError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = err;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ApiConnErrCtor = (OpenAI as any).APIConnectionError as  // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | (new (...args: any) => Error)
      | undefined;
    if (ApiConnErrCtor && e instanceof ApiConnErrCtor) {
      return true;
    }
    const NETWORK_ERRNOS = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ]);
    if (typeof e.code === "string" && NETWORK_ERRNOS.has(e.code)) {
      return true;
    }
    if (
      e.cause &&
      typeof e.cause === "object" &&
      NETWORK_ERRNOS.has((e.cause as { code?: string }).code ?? "")
    ) {
      return true;
    }
    if (typeof e.status === "number" && e.status >= 500) {
      return true;
    }
    if (
      typeof e.message === "string" &&
      /network|socket|stream/i.test(e.message)
    ) {
      return true;
    }
    return false;
  }

  private isInvalidRequestError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e: any = err;
    if (e.type === "invalid_request_error" && e.code === "model_not_found") {
      return true;
    }
    if (
      e.cause &&
      e.cause.type === "invalid_request_error" &&
      e.cause.code === "model_not_found"
    ) {
      return true;
    }
    return false;
  }

  private async handleFunctionCall(
    item: ResponseFunctionToolCall,
  ): Promise<Array<ResponseInputItem>> {
    // If the agent has been canceled in the meantime we should not perform any
    // additional work. Returning an empty array ensures that we neither execute
    // the requested tool call nor enqueue any follow‑up input items. This keeps
    // the cancellation semantics intuitive for users – once they interrupt a
    // task no further actions related to that task should be taken.
    if (this.canceled) {
      return [];
    }
    // ---------------------------------------------------------------------
    // Normalise the function‑call item into a consistent shape regardless of
    // whether it originated from the `/responses` or the `/chat/completions`
    // endpoint – their JSON differs slightly.
    // ---------------------------------------------------------------------

    const isChatStyle =
      // The chat endpoint nests function details under a `function` key.
      // We conservatively treat the presence of this field as a signal that
      // we are dealing with the chat format.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item as any).function != null;

    const name: string | undefined = isChatStyle
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).function?.name
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).name;

    const rawArguments: string | undefined = isChatStyle
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).function?.arguments
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (item as any).arguments;

    // The OpenAI "function_call" item may have either `call_id` (responses
    // endpoint) or `id` (chat endpoint).  Prefer `call_id` if present but fall
    // back to `id` to remain compatible.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callId: string = (item as any).call_id ?? (item as any).id;

    log(
      `handleFunctionCall(): name=${
        name ?? "undefined"
      } callId=${callId} args=${rawArguments}`,
    );

    const outputItem: ResponseInputItem.FunctionCallOutput = {
      type: "function_call_output",
      // `call_id` is mandatory – ensure we never send `undefined` which would
      // trigger the "No tool output found…" 400 from the API.
      call_id: callId,
      output: "no function found",
    };

    // We intentionally *do not* remove this `callId` from the `pendingAborts`
    // set right away.  The output produced below is only queued up for the
    // *next* request to the OpenAI API – it has not been delivered yet.  If
    // the user presses ESC‑ESC (i.e. invokes `cancel()`) in the small window
    // between queuing the result and the actual network call, we need to be
    // able to surface a synthetic `function_call_output` marked as
    // "aborted".  Keeping the ID in the set until the run concludes
    // successfully lets the next `run()` differentiate between an aborted
    // tool call (needs the synthetic output) and a completed one (cleared
    // below in the `flush()` helper).

    // used to tell model to stop if needed
    const additionalItems: Array<ResponseInputItem> = [];

    if (name === "continue") {
      outputItem.output = "continue";
      return [outputItem];
    }

    if (name === "last_response") {
      this.stopAfterCurrentTurn = true;
      return [];
    }

    // dispatch built-in shell tools directly, everything else is handled via a
    // generic fallback so that custom tools specified in `tools` work as well
    if (name === "container.exec" || name === "shell") {
      const parsedArgs = parseToolCallArguments(rawArguments ?? "{}");
      if (!parsedArgs.ok) {
        const invalid: ResponseInputItem.FunctionCallOutput = {
          type: "function_call_output",
          call_id: callId,
          output: `error: ${parsedArgs.error}`,
        };
        return [invalid];
      }
      const args = parsedArgs.value;
      const {
        outputText,
        metadata,
        additionalItems: additionalItemsFromExec,
      } = await handleExecCommand(
        args,
        this.config,
        this.approvalPolicy,
        this.additionalWritableRoots,
        this.getCommandConfirmation,
        this.execAbortController?.signal,
      );
      outputItem.output = JSON.stringify({ output: outputText, metadata });

      if (
        this.jsonResponse &&
        Array.isArray(args.cmd) &&
        args.cmd[0] &&
        ["ls", "find"].includes(args.cmd[0])
      ) {
        this.jsonResponse.file_structure = outputText;
      }

      if (additionalItemsFromExec) {
        additionalItems.push(...additionalItemsFromExec);
      }
    } else if (name === "apply_patch") {
      const args = parseApplyPatchArguments(rawArguments ?? "{}");
      if (args == null) {
        const invalid: ResponseInputItem.FunctionCallOutput = {
          type: "function_call_output",
          call_id: callId,
          output: `invalid arguments: ${rawArguments}`,
        };
        return [invalid];
      }
      const execArgs = {
        cmd: ["apply_patch", args.patch],
        workdir: args.workdir,
        timeoutInMillis: undefined,
      };
      const { outputText, metadata, additionalItems: additionalItemsFromExec } =
        await handleExecCommand(
          execArgs,
          this.config,
          this.approvalPolicy,
          this.additionalWritableRoots,
          this.getCommandConfirmation,
          this.execAbortController?.signal,
        );
      outputItem.output = JSON.stringify({ output: outputText, metadata });
      if (additionalItemsFromExec) {
        additionalItems.push(...additionalItemsFromExec);
      }
    } else {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = rawArguments ? JSON.parse(rawArguments) : {};
      } catch {
        parsedArgs = {};
      }

      const {
        outputText,
        metadata = {},
        additionalItems: genericAdditional,
      } = await this.handleGenericToolCall(name ?? "", parsedArgs);
      outputItem.output = JSON.stringify({ output: outputText, metadata });
      if (genericAdditional) {
        additionalItems.push(...genericAdditional);
      }
    }

    return [outputItem, ...additionalItems];
  }

  /**
   * Generic handler for non-shell function tools. The default implementation
   * simply echoes the call name and arguments back to the model. Tests can
   * spy on this method to verify dispatch behaviour.
   */
  protected async handleGenericToolCall(
    name: string,
    _args: Record<string, unknown>,
  ): Promise<{
    outputText: string;
    metadata?: Record<string, unknown>;
    additionalItems?: Array<ResponseInputItem>;
  }> {
    return { outputText: name };
  }

  private async handleLocalShellCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: any,
  ): Promise<Array<ResponseInputItem>> {
    // If the agent has been canceled in the meantime we should not perform any
    // additional work. Returning an empty array ensures that we neither execute
    // the requested tool call nor enqueue any follow‑up input items. This keeps
    // the cancellation semantics intuitive for users – once they interrupt a
    // task no further actions related to that task should be taken.
    if (this.canceled) {
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outputItem: any = {
      type: "local_shell_call_output",
      // `call_id` is mandatory – ensure we never send `undefined` which would
      // trigger the "No tool output found…" 400 from the API.
      call_id: item.call_id,
      output: "no function found",
    };

    // We intentionally *do not* remove this `callId` from the `pendingAborts`
    // set right away.  The output produced below is only queued up for the
    // *next* request to the OpenAI API – it has not been delivered yet.  If
    // the user presses ESC‑ESC (i.e. invokes `cancel()`) in the small window
    // between queuing the result and the actual network call, we need to be
    // able to surface a synthetic `function_call_output` marked as
    // "aborted".  Keeping the ID in the set until the run concludes
    // successfully lets the next `run()` differentiate between an aborted
    // tool call (needs the synthetic output) and a completed one (cleared
    // below in the `flush()` helper).

    // used to tell model to stop if needed
    const additionalItems: Array<ResponseInputItem> = [];

    if (item.action.type !== "exec") {
      throw new Error("Invalid action type");
    }

    const args = {
      cmd: item.action.command,
      workdir: item.action.working_directory,
      timeoutInMillis: item.action.timeout_ms,
    };

    const {
      outputText,
      metadata,
      additionalItems: additionalItemsFromExec,
    } = await handleExecCommand(
      args,
      this.config,
      this.approvalPolicy,
      this.additionalWritableRoots,
      this.getCommandConfirmation,
      this.execAbortController?.signal,
    );
    outputItem.output = JSON.stringify({ output: outputText, metadata });

    if (
      this.jsonResponse &&
      Array.isArray(args.cmd) &&
      ["ls", "find"].includes(args.cmd[0])
    ) {
      this.jsonResponse.file_structure = outputText;
    }

    if (additionalItemsFromExec) {
      additionalItems.push(...additionalItemsFromExec);
    }

    return [outputItem, ...additionalItems];
  }

  public async run(
    input: Array<ResponseInputItem>,
    previousResponseId: string = "",
  ): Promise<void> {
    // ---------------------------------------------------------------------
    // Top‑level error wrapper so that known transient network issues like
    // `ERR_STREAM_PREMATURE_CLOSE` do not crash the entire CLI process.
    // Instead we surface the failure to the user as a regular system‑message
    // and terminate the current run gracefully. The calling UI can then let
    // the user retry the request if desired.
    // ---------------------------------------------------------------------

    try {
      if (this.terminated) {
        throw new Error("AgentLoop has been terminated");
      }
      if (this.jsonResponse && !fs.existsSync("src")) {
        this.jsonResponse.status = "complete_with_limitations";
        this.jsonResponse.analysis =
          this.jsonResponse.analysis ?? "src directory missing";
      }
      // Record when we start "thinking" so we can report accurate elapsed time.
      const thinkingStart = Date.now();
      // Bump generation so that any late events from previous runs can be
      // identified and dropped.
      const thisGeneration = ++this.generation;

      // Reset cancellation flag and stream for a fresh run.
      this.canceled = false;
      this.stopAfterCurrentTurn = false;
      this.currentStream = null;

      // Create a fresh AbortController for this run so that tool calls from a
      // previous run do not accidentally get signalled.
      this.execAbortController = new AbortController();
      log(
        `AgentLoop.run(): new execAbortController created (${this.execAbortController.signal}) for generation ${this.generation}`,
      );
      // NOTE: We no longer (re‑)attach an `abort` listener to `hardAbort` here.
      // A single listener that forwards the `abort` to the current
      // `execAbortController` is installed once in the constructor. Re‑adding a
      // new listener on every `run()` caused the same `AbortSignal` instance to
      // accumulate listeners which in turn triggered Node's
      // `MaxListenersExceededWarning` after ten invocations.

      // Track the response ID from the last *stored* response so we can use
      // `previous_response_id` when `disableResponseStorage` is enabled.  When storage
      // is disabled we deliberately ignore the caller‑supplied value because
      // the backend will not retain any state that could be referenced.
      // If the backend stores conversation state (`disableResponseStorage === false`) we
      // forward the caller‑supplied `previousResponseId` so that the model sees the
      // full context.  When storage is disabled we *must not* send any ID because the
      // server no longer retains the referenced response.
      let lastResponseId: string = this.disableResponseStorage
        ? ""
        : previousResponseId;

      // If there are unresolved function calls from a previously cancelled run
      // we have to emit dummy tool outputs so that the API no longer expects
      // them.  We prepend them to the user‑supplied input so they appear
      // first in the conversation turn.
      const abortOutputs: Array<ResponseInputItem> = [];
      if (this.pendingAborts.size > 0) {
        for (const id of this.pendingAborts) {
          abortOutputs.push({
            type: "function_call_output",
            call_id: id,
            output: JSON.stringify({
              output: "aborted",
              metadata: { exit_code: 1, duration_seconds: 0 },
            }),
          } as ResponseInputItem.FunctionCallOutput);
        }
        // Once converted the pending list can be cleared.
        this.pendingAborts.clear();
      }

      // Build the input list for this turn. When responses are stored on the
      // server we can simply send the *delta* (the new user input as well as
      // any pending abort outputs) and rely on `previous_response_id` for
      // context.  When storage is disabled the server has no memory of the
      // conversation, so we must include the *entire* transcript (minus system
      // messages) on every call.

      let turnInput: Array<ResponseInputItem> = [];
      // Keeps track of how many items in `turnInput` stem from the existing
      // transcript so we can avoid re‑emitting them to the UI. Only used when
      // `disableResponseStorage === true`.
      let transcriptPrefixLen = 0;

      let tools: Array<Tool> = [
        shellFunctionTool,
        continueTool,
        lastResponseTool,
      ];
      if (this.model.startsWith("codex")) {
        tools = [localShellTool, continueTool, lastResponseTool];
      }

      const stripInternalFields = this.stripInternalFields.bind(this);

      if (this.disableResponseStorage) {
        // Remember where the existing transcript ends – everything after this
        // index in the upcoming `turnInput` list will be *new* for this turn
        // and therefore needs to be surfaced to the UI.
        transcriptPrefixLen = this.transcript.length;

        // Ensure the transcript is up‑to‑date with the latest user input so
        // that subsequent iterations see a complete history.
        // `turnInput` is still empty at this point (it will be filled later).
        // We need to look at the *input* items the user just supplied.
        this.transcript.push(...filterToApiMessages(input));

        turnInput = [...this.transcript, ...abortOutputs].map(
          stripInternalFields,
        );
      } else {
        turnInput = [...abortOutputs, ...input].map(stripInternalFields);
      }

      this.onLoading(true);

      const staged: Array<ResponseItem | undefined> = [];
      const stageItem = (item: ResponseItem) => {
        // Ignore any stray events that belong to older generations.
        if (thisGeneration !== this.generation) {
          return;
        }

        // Skip items we've already processed to avoid staging duplicates
        if (item.id && alreadyStagedItemIds.has(item.id)) {
          return;
        }
        alreadyStagedItemIds.add(item.id);

        // Store the item so the final flush can still operate on a complete list.
        // We'll nil out entries once they're delivered.
        const idx = staged.push(item) - 1;

        // Instead of emitting synchronously we schedule a short‑delay delivery.
        //
        // This accomplishes two things:
        //   1. The UI still sees new messages almost immediately, creating the
        //      perception of real‑time updates.
        //   2. If the user calls `cancel()` in the small window right after the
        //      item was staged we can still abort the delivery because the
        //      generation counter will have been bumped by `cancel()`.
        //
        // Use a minimal 3ms delay for terminal rendering to maintain readable
        // streaming.
        setTimeout(() => {
          if (
            thisGeneration === this.generation &&
            !this.canceled &&
            !this.hardAbort.signal.aborted
          ) {
            this.onItem(item);
            // Mark as delivered so flush won't re-emit it
            staged[idx] = undefined;

            // Handle transcript updates to maintain consistency. When we
            // operate without server‑side storage we keep our own transcript
            // so we can provide full context on subsequent calls.
            if (this.disableResponseStorage) {
              // Exclude system messages from transcript as they do not form
              // part of the assistant/user dialogue that the model needs.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const role = (item as any).role;
              if (role !== "system") {
                // Clone the item to avoid mutating the object that is also
                // rendered in the UI. We need to strip auxiliary metadata
                // such as `duration_ms` which is not part of the Responses
                // API schema and therefore causes a 400 error when included
                // in subsequent requests whose context is sent verbatim.

                // Skip items that we have already inserted earlier or that the
                // model does not need to see again in the next turn.
                //   • function_call   – superseded by the forthcoming
                //     function_call_output.
                //   • reasoning       – internal only, never sent back.
                //   • user messages   – we added these to the transcript when
                //     building the first turnInput; stageItem would add a
                //     duplicate.
                if (
                  (item as ResponseInputItem).type === "function_call" ||
                  (item as ResponseInputItem).type === "reasoning" ||
                  //@ts-expect-error - waiting on sdk
                  (item as ResponseInputItem).type === "local_shell_call" ||
                  ((item as ResponseInputItem).type === "message" &&
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (item as any).role === "user")
                ) {
                  return;
                }

                const clone: ResponseInputItem = {
                  ...(item as unknown as ResponseInputItem),
                } as ResponseInputItem;
                // The `duration_ms` field is only added to reasoning items to
                // show elapsed time in the UI. It must not be forwarded back
                // to the server.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (clone as any).duration_ms;

                this.transcript.push(clone);
              }
            }
          }
        }, 3); // Small 3ms delay for readable streaming.
      };

      while (turnInput.length > 0) {
        if (this.canceled || this.hardAbort.signal.aborted) {
          this.onLoading(false);
          return;
        }
        // send request to openAI
        // Only surface the *new* input items to the UI – replaying the entire
        // transcript would duplicate messages that have already been shown in
        // earlier turns.
        // `turnInput` holds the *new* items that will be sent to the API in
        // this iteration.  Surface exactly these to the UI so that we do not
        // re‑emit messages from previous turns (which would duplicate user
        // prompts) and so that freshly generated `function_call_output`s are
        // shown immediately.
        // Figure out what subset of `turnInput` constitutes *new* information
        // for the UI so that we don't spam the interface with repeats of the
        // entire transcript on every iteration when response storage is
        // disabled.
        const deltaInput = this.disableResponseStorage
          ? turnInput.slice(transcriptPrefixLen)
          : [...turnInput];
        for (const item of deltaInput) {
          stageItem(item as ResponseItem);
        }
        // Send request to OpenAI with retry on timeout.
        let stream;

        // Retry loop for transient errors. Up to MAX_RETRIES attempts.
        const MAX_RETRIES = 8;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            let reasoning: Reasoning | undefined;
            let modelSpecificInstructions: string | undefined;
            if (this.model.startsWith("o") || this.model.startsWith("codex")) {
              reasoning = { effort: this.config.reasoningEffort ?? "medium" };
              reasoning.summary = "auto";
            }
            if (this.model.startsWith("gpt-4.1")) {
              modelSpecificInstructions = applyPatchToolInstructions;
            }
            const mergedInstructions = [
              prefix,
              modelSpecificInstructions,
              this.instructions,
            ]
              .filter(Boolean)
              .join("\n");

            const responseCall =
              !this.config.provider ||
              this.config.provider?.toLowerCase() === "openai"
                ? (params: ResponseCreateParams) =>
                    this.oai.responses.create(params)
                : (params: ResponseCreateParams) =>
                    responsesCreateViaChatCompletions(
                      this.oai,
                      params as ResponseCreateParams & { stream: true },
                    );
            log(
              `instructions (length ${mergedInstructions.length}): ${mergedInstructions}`,
            );

            // eslint-disable-next-line no-await-in-loop
            stream = await responseCall({
              model: this.model,
              instructions: mergedInstructions,
              input: turnInput,
              stream: true,
              parallel_tool_calls: false,
              reasoning,
              ...(this.config.flexMode ? { service_tier: "flex" } : {}),
              ...(this.disableResponseStorage
                ? { store: false }
                : {
                    store: true,
                    previous_response_id: lastResponseId || undefined,
                  }),
              tools: tools,
              // Explicitly tell the model it is allowed to pick whatever
              // tool it deems appropriate.  Omitting this sometimes leads to
              // the model ignoring the available tools and responding with
              // plain text instead (resulting in a missing tool‑call).
              tool_choice: "auto",
            });
            break;
          } catch (error) {
            const isTimeout = error instanceof APIConnectionTimeoutError;
            // Lazily look up the APIConnectionError class at runtime to
            // accommodate the test environment's minimal OpenAI mocks which
            // do not define the class.  Falling back to `false` when the
            // export is absent ensures the check never throws.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ApiConnErrCtor = (OpenAI as any).APIConnectionError as  // eslint-disable-next-line @typescript-eslint/no-explicit-any
              | (new (...args: any) => Error)
              | undefined;
            const isConnectionError = ApiConnErrCtor
              ? error instanceof ApiConnErrCtor
              : false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errCtx = error as any;
            const status =
              errCtx?.status ?? errCtx?.httpStatus ?? errCtx?.statusCode;
            // Treat classical 5xx *and* explicit OpenAI `server_error` types
            // as transient server-side failures that qualify for a retry. The
            // SDK often omits the numeric status for these, reporting only
            // the `type` field.
            const isServerError =
              (typeof status === "number" && status >= 500) ||
              errCtx?.type === "server_error";
            if (
              (isTimeout || isServerError || isConnectionError) &&
              attempt < MAX_RETRIES
            ) {
              log(
                `OpenAI request failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
              );
              continue;
            }

            const isTooManyTokensError =
              (errCtx.param === "max_tokens" ||
                (typeof errCtx.message === "string" &&
                  /max_tokens is too large/i.test(errCtx.message))) &&
              errCtx.type === "invalid_request_error";

            if (isTooManyTokensError) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: "⚠️  The current request exceeds the maximum context length supported by the chosen model. Please shorten the conversation, run /clear, or switch to a model with a larger context window and try again.",
                  },
                ],
              });
              this.onLoading(false);
              return;
            }

            const isRateLimit =
              status === 429 ||
              errCtx.code === "rate_limit_exceeded" ||
              errCtx.type === "rate_limit_exceeded" ||
              /rate limit/i.test(errCtx.message ?? "");
            if (isRateLimit) {
              if (attempt < MAX_RETRIES) {
                // Exponential backoff: base wait * 2^(attempt-1), or use suggested retry time
                // if provided.
                let delayMs = RATE_LIMIT_RETRY_WAIT_MS * 2 ** (attempt - 1);

                // Parse suggested retry time from error message, e.g., "Please try again in 1.3s"
                const msg = errCtx?.message ?? "";
                const m = /(?:retry|try) again in ([\d.]+)s/i.exec(msg);
                if (m && m[1]) {
                  const suggested = parseFloat(m[1]) * 1000;
                  if (!Number.isNaN(suggested)) {
                    delayMs = suggested;
                  }
                }
                log(
                  `OpenAI rate limit exceeded (attempt ${attempt}/${MAX_RETRIES}), retrying in ${Math.round(
                    delayMs,
                  )} ms...`,
                );
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              } else {
                // We have exhausted all retry attempts. Surface a message so the user understands
                // why the request failed and can decide how to proceed (e.g. wait and retry later
                // or switch to a different model / account).

                const errorDetails = [
                  `Status: ${status || "unknown"}`,
                  `Code: ${errCtx.code || "unknown"}`,
                  `Type: ${errCtx.type || "unknown"}`,
                  `Message: ${errCtx.message || "unknown"}`,
                ].join(", ");

                this.onItem({
                  id: `error-${Date.now()}`,
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `⚠️  Rate limit reached. Error details: ${errorDetails}. Please try again later.`,
                    },
                  ],
                });

                this.onLoading(false);
                return;
              }
            }

            const isClientError =
              (typeof status === "number" &&
                status >= 400 &&
                status < 500 &&
                status !== 429) ||
              errCtx.code === "invalid_request_error" ||
              errCtx.type === "invalid_request_error";
            if (isClientError) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    // Surface the request ID when it is present on the error so users
                    // can reference it when contacting support or inspecting logs.
                    text: (() => {
                      const reqId =
                        (
                          errCtx as Partial<{
                            request_id?: string;
                            requestId?: string;
                          }>
                        )?.request_id ??
                        (
                          errCtx as Partial<{
                            request_id?: string;
                            requestId?: string;
                          }>
                        )?.requestId;

                      const errorDetails = [
                        `Status: ${status || "unknown"}`,
                        `Code: ${errCtx.code || "unknown"}`,
                        `Type: ${errCtx.type || "unknown"}`,
                        `Message: ${errCtx.message || "unknown"}`,
                      ].join(", ");

                      return `⚠️  OpenAI rejected the request${
                        reqId ? ` (request ID: ${reqId})` : ""
                      }. Error details: ${errorDetails}. Please verify your settings and try again.`;
                    })(),
                  },
                ],
              });
              this.onLoading(false);
              return;
            }
            throw error;
          }
        }

        // If the user requested cancellation while we were awaiting the network
        // request, abort immediately before we start handling the stream.
        if (this.canceled || this.hardAbort.signal.aborted) {
          // `stream` is defined; abort to avoid wasting tokens/server work
          try {
            (
              stream as { controller?: { abort?: () => void } }
            )?.controller?.abort?.();
          } catch {
            /* ignore */
          }
          this.onLoading(false);
          return;
        }

        // Keep track of the active stream so it can be aborted on demand.
        this.currentStream = stream;

        // Guard against an undefined stream before iterating.
        if (!stream) {
          this.onLoading(false);
          log("AgentLoop.run(): stream is undefined");
          return;
        }

        const MAX_STREAM_RETRIES = 5;
        let streamRetryAttempt = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            let newTurnInput: Array<ResponseInputItem> = [];

            // eslint-disable-next-line no-await-in-loop
            for await (const event of stream as AsyncIterable<ResponseEvent>) {
              log(`AgentLoop.run(): response event ${event.type}`);

              // process and surface each item (no-op until we can depend on streaming events)
              if (event.type === "response.output_item.done") {
                const item = event.item;
                // 1) if it's a reasoning item, annotate it
                type ReasoningItem = { type?: string; duration_ms?: number };
                const maybeReasoning = item as ReasoningItem;
                if (maybeReasoning.type === "reasoning") {
                  maybeReasoning.duration_ms = Date.now() - thinkingStart;
                }
                if (
                  item.type === "function_call" ||
                  item.type === "local_shell_call"
                ) {
                  // Track outstanding tool call so we can abort later if needed.
                  // The item comes from the streaming response, therefore it has
                  // either `id` (chat) or `call_id` (responses) – we normalise
                  // by reading both.
                  const callId =
                    (item as { call_id?: string; id?: string }).call_id ??
                    (item as { id?: string }).id;
                  if (callId) {
                    this.pendingAborts.add(callId);
                  }
                } else {
                  stageItem(item as ResponseItem);
                }
              }

              if (event.type === "response.completed") {
                if (thisGeneration === this.generation && !this.canceled) {
                  for (const item of event.response.output) {
                    stageItem(item as ResponseItem);
                  }
                }
                if (
                  event.response.status === "completed" ||
                  (event.response.status as unknown as string) ===
                    "requires_action"
                ) {
                  // TODO: remove this once we can depend on streaming events
                  newTurnInput = await this.processEventsWithoutStreaming(
                    event.response.output,
                    stageItem,
                  );

                  // When we do not use server‑side storage we maintain our
                  // own transcript so that *future* turns still contain full
                  // conversational context. However, whether we advance to
                  // another loop iteration should depend solely on the
                  // presence of *new* input items (i.e. items that were not
                  // part of the previous request). Re‑sending the transcript
                  // by itself would create an infinite request loop because
                  // `turnInput.length` would never reach zero.

                  if (this.disableResponseStorage) {
                    // 1) Append the freshly emitted output to our local
                    //    transcript (minus non‑message items the model does
                    //    not need to see again).
                    const cleaned = filterToApiMessages(
                      event.response.output.map(stripInternalFields),
                    );
                    this.transcript.push(...cleaned);

                    // 2) Determine the *delta* (newTurnInput) that must be
                    //    sent in the next iteration. If there is none we can
                    //    safely terminate the loop – the transcript alone
                    //    does not constitute new information for the
                    //    assistant to act upon.

                    const delta = filterToApiMessages(
                      newTurnInput.map(stripInternalFields),
                    );

                    if (delta.length === 0) {
                      // No new input => end conversation.
                      newTurnInput = [];
                    } else {
                      // Re‑send full transcript *plus* the new delta so the
                      // stateless backend receives complete context.
                      newTurnInput = [...this.transcript, ...delta];
                      // The prefix ends at the current transcript length –
                      // everything after this index is new for the next
                      // iteration.
                      transcriptPrefixLen = this.transcript.length;
                    }
                  }
                }
                lastResponseId = event.response.id;
                this.onLastResponseId(event.response.id);
              }
            }

            // Set after we have consumed all stream events in case the stream wasn't
            // complete or we missed events for whatever reason. That way, we will set
            // the next turn to an empty array to prevent an infinite loop.
            // And don't update the turn input too early otherwise we won't have the
            // current turn inputs available for retries.
            turnInput = this.stopAfterCurrentTurn ? [] : newTurnInput;

            // Stream finished successfully – leave the retry loop.
            break;
          } catch (err: unknown) {
            if (
              this.isRateLimitError(err) &&
              streamRetryAttempt < MAX_STREAM_RETRIES
            ) {
              streamRetryAttempt += 1;

              const waitMs =
                RATE_LIMIT_RETRY_WAIT_MS * 2 ** (streamRetryAttempt - 1);
              log(
                `OpenAI stream rate‑limited – retry ${streamRetryAttempt}/${MAX_STREAM_RETRIES} in ${waitMs} ms`,
              );

              // Give the server a breather before retrying.
              // eslint-disable-next-line no-await-in-loop
              await new Promise((res) => setTimeout(res, waitMs));

              // Re‑create the stream with the *same* parameters.
              let reasoning: Reasoning | undefined;
              if (this.model.startsWith("o")) {
                reasoning = { effort: "high" };
                if (
                  this.model === "o3" ||
                  this.model === "o4-mini" ||
                  this.model === "codex-mini-latest"
                ) {
                  reasoning.summary = "auto";
                }
              }

              const mergedInstructions = [prefix, this.instructions]
                .filter(Boolean)
                .join("\n");

              const responseCall =
                !this.config.provider ||
                this.config.provider?.toLowerCase() === "openai"
                  ? (params: ResponseCreateParams) =>
                      this.oai.responses.create(params)
                  : (params: ResponseCreateParams) =>
                      responsesCreateViaChatCompletions(
                        this.oai,
                        params as ResponseCreateParams & { stream: true },
                      );

              log(
                "agentLoop.run(): responseCall(1): turnInput: " +
                  JSON.stringify(turnInput),
              );
              // eslint-disable-next-line no-await-in-loop
              stream = await responseCall({
                model: this.model,
                instructions: mergedInstructions,
                input: turnInput,
                stream: true,
                parallel_tool_calls: false,
                reasoning,
                ...(this.config.flexMode ? { service_tier: "flex" } : {}),
                ...(this.disableResponseStorage
                  ? { store: false }
                  : {
                      store: true,
                      previous_response_id: lastResponseId || undefined,
                    }),
                tools: tools,
                tool_choice: "auto",
              });

              this.currentStream = stream;
              // Continue to outer while to consume new stream.
              continue;
            }

            // Gracefully handle an abort triggered via `cancel()` so that the
            // consumer does not see an unhandled exception.
            if (err instanceof Error && err.name === "AbortError") {
              if (!this.canceled) {
                // It was aborted for some other reason; surface the error.
                throw err;
              }
              this.onLoading(false);
              return;
            }
            // Suppress internal stack on JSON parse failures
            if (err instanceof SyntaxError) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: "⚠️ Failed to parse streaming response (invalid JSON). Please `/clear` to reset.",
                  },
                ],
              });
              this.onLoading(false);
              return;
            }
            // Handle OpenAI API quota errors
            if (
              err instanceof Error &&
              (err as { code?: string }).code === "insufficient_quota"
            ) {
              this.onItem({
                id: `error-${Date.now()}`,
                type: "message",
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: `\u26a0 Insufficient quota: ${err instanceof Error && err.message ? err.message.trim() : "No remaining quota."} Manage or purchase credits at https://platform.openai.com/account/billing.`,
                  },
                ],
              });
              this.onLoading(false);
              return;
            }
            throw err;
          } finally {
            this.currentStream = null;
          }
        } // end while retry loop

        log(
          `Turn inputs (${turnInput.length}) - ${turnInput
            .map((i) => i.type)
            .join(", ")}`,
        );
      }

      // Flush staged items if the run concluded successfully (i.e. the user did
      // not invoke cancel() or terminate() during the turn).
      const flush = () => {
        if (
          !this.canceled &&
          !this.hardAbort.signal.aborted &&
          thisGeneration === this.generation
        ) {
          // Only emit items that weren't already delivered above
          for (const item of staged) {
            if (item) {
              this.onItem(item);
            }
          }
        }

        // At this point the turn finished without the user invoking
        // `cancel()`.  Any outstanding function‑calls must therefore have been
        // satisfied, so we can safely clear the set that tracks pending aborts
        // to avoid emitting duplicate synthetic outputs in subsequent runs.
        this.pendingAborts.clear();
        // Now emit system messages recording the per‑turn *and* cumulative
        // thinking times so UIs and tests can surface/verify them.
        // const thinkingEnd = Date.now();

        // 1) Per‑turn measurement – exact time spent between request and
        //    response for *this* command.
        // this.onItem({
        //   id: `thinking-${thinkingEnd}`,
        //   type: "message",
        //   role: "system",
        //   content: [
        //     {
        //       type: "input_text",
        //       text: `🤔  Thinking time: ${Math.round(
        //         (thinkingEnd - thinkingStart) / 1000
        //       )} s`,
        //     },
        //   ],
        // });

        // 2) Session‑wide cumulative counter so users can track overall wait
        //    time across multiple turns.
        // this.cumulativeThinkingMs += thinkingEnd - thinkingStart;
        // this.onItem({
        //   id: `thinking-total-${thinkingEnd}`,
        //   type: "message",
        //   role: "system",
        //   content: [
        //     {
        //       type: "input_text",
        //       text: `⏱  Total thinking time: ${Math.round(
        //         this.cumulativeThinkingMs / 1000
        //       )} s`,
        //     },
        //   ],
        // });

        this.onLoading(false);
      };

      // Use a small delay to make sure UI rendering is smooth. Double-check
      // cancellation state right before flushing to avoid race conditions.
      setTimeout(() => {
        if (
          !this.canceled &&
          !this.hardAbort.signal.aborted &&
          thisGeneration === this.generation
        ) {
          flush();
        }
      }, 3);

      // End of main logic. The corresponding catch block for the wrapper at the
      // start of this method follows next.
    } catch (err) {
      // Handle known transient network/streaming issues so they do not crash the
      // CLI. We currently match Node/undici's `ERR_STREAM_PREMATURE_CLOSE`
      // error which manifests when the HTTP/2 stream terminates unexpectedly
      // (e.g. during brief network hiccups).

      const isPrematureClose =
        err instanceof Error &&
        // eslint-disable-next-line
        ((err as any).code === "ERR_STREAM_PREMATURE_CLOSE" ||
          err.message?.includes("Premature close"));

      if (isPrematureClose) {
        try {
          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "⚠️  Connection closed prematurely while waiting for the model. Please try again.",
              },
            ],
          });
        } catch {
          /* no-op – emitting the error message is best‑effort */
        }
        this.onLoading(false);
        return;
      }

      // -------------------------------------------------------------------
      // Catch‑all handling for other network or server‑side issues so that
      // transient failures do not crash the CLI. We intentionally keep the
      // detection logic conservative to avoid masking programming errors. A
      // failure is treated as retry‑worthy/user‑visible when any of the
      // following apply:
      //   • the error carries a recognised Node.js network errno ‑ style code
      //     (e.g. ECONNRESET, ETIMEDOUT …)
      //   • the OpenAI SDK attached an HTTP `status` >= 500 indicating a
      //     server‑side problem.
      //   • the error is model specific and detected in stream.
      // If matched we emit a single system message to inform the user and
      // resolve gracefully so callers can choose to retry.
      // -------------------------------------------------------------------

      const isNetworkOrServerError = this.isNetworkOrServerError(err);

      if (isNetworkOrServerError) {
        try {
          const msgText =
            "⚠️  Network error while contacting OpenAI. Please check your connection and try again.";
          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: msgText,
              },
            ],
          });
        } catch {
          /* best‑effort */
        }
        this.onLoading(false);
        return;
      }

      const isInvalidRequestError = this.isInvalidRequestError(err);

      if (isInvalidRequestError) {
        try {
          // Extract request ID and error details from the error object

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e: any = err;

          const reqId =
            e.request_id ??
            (e.cause && e.cause.request_id) ??
            (e.cause && e.cause.requestId);

          const errorDetails = [
            `Status: ${e.status || (e.cause && e.cause.status) || "unknown"}`,
            `Code: ${e.code || (e.cause && e.cause.code) || "unknown"}`,
            `Type: ${e.type || (e.cause && e.cause.type) || "unknown"}`,
            `Message: ${
              e.message || (e.cause && e.cause.message) || "unknown"
            }`,
          ].join(", ");

          const msgText = `⚠️  OpenAI rejected the request${
            reqId ? ` (request ID: ${reqId})` : ""
          }. Error details: ${errorDetails}. Please verify your settings and try again.`;

          this.onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: msgText,
              },
            ],
          });
        } catch {
          /* best-effort */
        }
        this.onLoading(false);
        return;
      }

      // Re‑throw all other errors so upstream handlers can decide what to do.
      throw err;
    } finally {
      if (this.jsonResponse) {
        if (!this.jsonResponse.status) {
          this.jsonResponse.status = "complete";
        }
        try {
          this.sendResponse(JSON.stringify(this.jsonResponse));
        } catch {
          /* ignore */
        }
      }
    }
  }

  private parseTextToolCall(text: string): ResponseItem | null {
    const trimmed = text.trim();
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      if (first !== -1 && last !== -1 && first < last) {
        try {
          obj = JSON.parse(trimmed.slice(first, last + 1));
        } catch {
          obj = null;
        }
      }
    }
    if (!obj) {
      return null;
    }
    try {
      if (obj && typeof obj === "object") {
        if (obj["name"] === "apply_patch") {
          const args = parseApplyPatchArguments(JSON.stringify((obj as Record<string, unknown>)["parameters"] ?? {}));
          if (!args) {
            return null;
          }
          return {
            type: "local_shell_call" as const,
            id: randomUUID(),
            status: "completed",
            call_id: randomUUID(),
            action: {
              type: "exec",
              command: ["apply_patch", args.patch],
              working_directory: args.workdir,
              timeout_ms: undefined,
            },
          } as unknown as ResponseItem;
        }
        const parsedArgs = parseToolCallArguments(JSON.stringify(obj));
        if (!parsedArgs.ok) {
          return null;
        }
        const args = parsedArgs.value;
        return {
          type: "local_shell_call" as const,
          id: randomUUID(),
          status: "completed",
          call_id: randomUUID(),
          action: {
            type: "exec",
            command: args.cmd,
            working_directory: args.workdir,
            timeout_ms: args.timeoutInMillis,
          },
        } as unknown as ResponseItem;
      }
    } catch {
      if (trimmed.includes('"name": "apply_patch"')) {
        const startIdx = trimmed.indexOf('*** Begin Patch');
        const endIdx = trimmed.indexOf('*** End Patch');
        if (startIdx !== -1 && endIdx !== -1) {
          const patch = trimmed.slice(startIdx, endIdx + '*** End Patch'.length);
          return {
            type: "local_shell_call" as const,
            id: randomUUID(),
            status: "completed",
            call_id: randomUUID(),
            action: {
              type: "exec",
              command: ["apply_patch", patch],
              working_directory: undefined,
              timeout_ms: undefined,
            },
          } as unknown as ResponseItem;
        }
      }
    }
    return null;
  }

  // we need until we can depend on streaming events
  private async processEventsWithoutStreaming(
    output: Array<ResponseInputItem>,
    emitItem: (item: ResponseItem) => void,
  ): Promise<Array<ResponseInputItem>> {
    // If the agent has been canceled we should short‑circuit immediately to
    // avoid any further processing (including potentially expensive tool
    // calls). Returning an empty array ensures the main run‑loop terminates
    // promptly.
    if (this.canceled) {
      return [];
    }
    const turnInput: Array<ResponseInputItem> = [];
    for (const item of output) {
      if (item.type === "function_call") {
        if (alreadyProcessedResponses.has(item.id)) {
          continue;
        }
        alreadyProcessedResponses.add(item.id);
        // eslint-disable-next-line no-await-in-loop
        const result = await this.handleFunctionCall(item);
        turnInput.push(...result);
        //@ts-expect-error - waiting on sdk
      } else if (item.type === "local_shell_call") {
        //@ts-expect-error - waiting on sdk
        if (alreadyProcessedResponses.has(item.id)) {
          continue;
        }
        //@ts-expect-error - waiting on sdk
        alreadyProcessedResponses.add(item.id);
        // eslint-disable-next-line no-await-in-loop
        const result = await this.handleLocalShellCall(item);
        turnInput.push(...result);
      } else if (
        item.type === "message" &&
        (item as { role?: string }).role === "assistant"
      ) {
        const parts = (item as { content?: Array<{ type?: string; text?: string }> }).content;
        if (
          Array.isArray(parts) &&
          parts.length === 1 &&
          parts[0] &&
          parts[0].type === "output_text"
        ) {
          const text = (parts[0].text || "").trim();
          const parsed = this.parseTextToolCall(text);
          if (parsed) {
            // @ts-expect-error - local_shell_call is not part of ResponseItem union
            if ((parsed as ResponseItem).type === "local_shell_call") {
              // eslint-disable-next-line no-await-in-loop
              const result = await this.handleLocalShellCall(parsed as ResponseItem);
              turnInput.push(...result);
            } else {
              // eslint-disable-next-line no-await-in-loop -- @ts-expect-error mismatched ResponseItem type
              const result = await this.handleFunctionCall(parsed as ResponseItem);
              turnInput.push(...result);
            }
            continue;
          }
        }
      }
      emitItem(item as ResponseItem);
    }
    return turnInput;
  }
}

// Dynamic developer message prefix: includes user, workdir, and rg suggestion.
const userName = os.userInfo().username;
const workdir = process.cwd();
const { platform, shell } = getEnvironmentInfo();
const dynamicLines: Array<string> = [
  `User: ${userName}`,
  `Workdir: ${workdir}`,
  `Platform: ${platform}`,
  `Shell: ${shell}`,
];
if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0) {
  dynamicLines.push(
    "- Always use rg instead of grep/ls -R because it is much faster and respects gitignore",
  );
}
const dynamicPrefix = dynamicLines.join("\n");

const prefix = `You are operating as and within the Codex CLI, a terminal-based agentic coding assistant built by OpenAI. It wraps OpenAI models to enable natural language interaction with a local codebase. The Codex CLI is designed as a general-purpose coding assistant, capable of working with any codebase in the user’s current working directory. You are expected to be precise, safe, and helpful.

You can:
- Receive user prompts, project context, and files.
- Stream responses and emit function calls (e.g., shell commands, code edits).
- Apply patches, run commands, and manage user approvals based on policy.
- Work inside a sandboxed, git-backed workspace with rollback support.
- Log telemetry so sessions can be replayed or inspected later.
- More details on your functionality are available at \`codex --help\`

The Codex CLI is open-sourced. Don’t confuse yourself with the old Codex language model built by OpenAI many moons ago. Within this context, Codex refers to the open-source agentic coding interface.

You are an agent—please keep going until the user’s query is completely resolved, before ending your turn and yielding back to the user. Only terminate your turn when you are confident that the problem is fully solved. If you are unsure about file content, codebase structure, or any aspect of the user’s request, use your tools (e.g., \`find\`, \`grep\`, or file reading) to gather relevant information from the current working directory. Do NOT guess, assume, or provide incomplete answers.

Please resolve the user’s task by analyzing and, if necessary, editing and testing code files in the current code execution session. You are a deployed coding agent. Your session allows you to modify and run code in the user’s working directory, and you must fully solve the problem for your answer to be considered correct. Your responses must be thorough, evidence-based, and robust, addressing the query comprehensively and anticipating potential follow-up questions.

You MUST adhere to the following criteria when executing the task:
- Working on the codebase in the current working directory is allowed, even if it is proprietary.
- Analyzing code for vulnerabilities is allowed.
- Showing user code and tool call details is allowed.
- Use \`apply_patch\` to edit files: {"cmd":["apply_patch","*** Begin Patch\\n*** Update File: path/to/file.py\\n@@ def example():\\n-  pass\\n+  return 123\\n*** End Patch"]}
  The patch must begin with \`*** Begin Patch\` and end with \`*** End Patch\`. Use \`*** Update File:\` or \`*** Add File:\` lines for each file. Provide hunks with @@ context.
  Example:
  {"cmd":["apply_patch","*** Begin Patch\\n*** Update File: hello.py\\n@@\\n+print('Hello World')\\n*** End Patch"]}
- To follow up with additional planning or actions in your next response, call \`continue\`: {"cmd":["continue"]}
- To end your turn early, call \`last_response\`: {"cmd":["last_response"]}
- If completing the user’s task requires writing or modifying files:
    - Your code and final answer should follow these *CODING GUIDELINES*:
        - Fix the problem at the root cause rather than applying surface-level patches, when possible.
        - Avoid unneeded complexity in your solution.
            - Ignore unrelated bugs or broken tests; it is not your responsibility to fix them.
        - Update documentation as necessary.
        - Keep changes consistent with the style of the existing codebase. Changes should be minimal and focused on the task.
            - Use \`git log\` and \`git blame\` to search the history of the codebase if additional context is required; internet access is disabled.
        - NEVER add copyright or license headers unless specifically requested.
        - You do not need to \`git commit\` your changes; this will be done automatically for you.
        - If there is a .pre-commit-config.yaml, use \`pre-commit run --files ...\` to check that your changes pass the pre-commit checks. However, do not fix pre-existing errors on lines you didn’t touch.
            - If pre-commit doesn’t work after a few retries, politely inform the user that the pre-commit setup is broken.
        - Once you finish coding, you must:
            - Remove all inline comments you added as much as possible, even if they look normal. Check using \`git diff\`. Inline comments must be generally avoided, unless active maintainers of the repo, after long careful study of the code and the issue, will still misinterpret the code without the comments.
            - Check if you accidentally added copyright or license headers. If so, remove them.
            - Try to run pre-commit if it is available.
            - For smaller tasks, describe in brief bullet points.
            - For more complex tasks, include a brief high-level description, use bullet points, and include details that would be relevant to a code reviewer.
- If completing the user’s task DOES NOT require writing or modifying files (e.g., the user asks a question about the code base):
    - Respond in a professional tone as a remote teammate who is knowledgeable, capable, and eager to help with coding.
- When your task involves writing or modifying files:
    - Do NOT tell the user to “save the file” or “copy the code into a file” if you already created or modified the file using \`apply_patch\`. Instead, reference the file as already saved.
    - Do NOT show the full contents of large files you have already written, unless the user explicitly asks for them.
- **Important**: If the user refers to a filename that does not exist, try to find the file using the \`find . -name FILENAME\` command.

## Investigative Approach

To ensure thorough and robust responses for all queries, follow these guidelines:
- **Comprehensive Exploration**: Exhaustively search the codebase using tools like \`find\`, \`grep\`, or file reading to locate all relevant code, configurations, or documentation. Explore multiple potential locations or mechanisms before concluding. Do not give up early or provide partial answers.
- **Iterative Analysis**: Iteratively refine your understanding by cross-referencing findings, checking for alternative implementations, and verifying assumptions with evidence from the codebase. If initial findings are inconclusive, continue searching until you have sufficient evidence.
- **Self-Reflection**: Before finalizing your response, evaluate its robustness by asking:
  - Does this answer fully resolve the user’s query?
  - Have I explored all relevant code paths, files, or mechanisms?
  - Is the response supported by concrete evidence from the codebase?
  - Have I considered edge cases, alternative explanations, or potential gaps in my analysis?
  - Could a follow-up question reveal a weakness in this answer?
  If the answer is not robust, continue investigating until it is comprehensive and defensible.
- **Evidence-Based Responses**: Base your answers on concrete evidence from the codebase, such as code snippets, file contents, or tool outputs. Avoid speculation or assumptions about code you have not verified.

${dynamicPrefix}`;

function filterToApiMessages(
  items: Array<ResponseInputItem>,
): Array<ResponseInputItem> {
  return items.filter((it) => {
    if (it.type === "message" && it.role === "system") {
      return false;
    }
    if (it.type === "reasoning") {
      return false;
    }
    return true;
  });
}
