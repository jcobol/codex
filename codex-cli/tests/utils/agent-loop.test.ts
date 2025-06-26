import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from "../../src/utils/agent/agent-loop.js";
import * as handleExec from "../../src/utils/agent/handle-exec-command.js";

// Basic mocks shared across tests
vi.mock("../../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: () => {},
  isLoggingEnabled: () => false,
}));

vi.mock("../../src/approvals.js", () => ({
  __esModule: true,
  alwaysApprovedCommands: new Set<string>(),
  canAutoApprove: () => ({ type: "auto-approve", runInSandbox: false }) as any,
  isSafeCommand: () => null,
}));

vi.mock("../../src/format-command.js", () => ({
  __esModule: true,
  formatCommandForDisplay: (c: Array<string>) => c.join(" "),
}));

// Helper to create a fake OpenAI stream from an array of events
class FakeStream {
  public controller = { abort: vi.fn() };
  private events: Array<any>;

  constructor(events: Array<any>) {
    this.events = events;
  }

  async *[Symbol.asyncIterator]() {
    for (const e of this.events) {
      yield e;
    }
  }
}

vi.mock("openai", () => {
  class FakeOpenAI {
    public responses = { create: async () => new FakeStream([]) };
  }
  class APIConnectionTimeoutError extends Error {}
  return { __esModule: true, default: FakeOpenAI, APIConnectionTimeoutError };
});

// Utility to build a simple agent instance
function buildAgent(overrides: any = {}) {
  return new AgentLoop({
    model: "any",
    instructions: "",
    approvalPolicy: { mode: "auto" } as any,
    additionalWritableRoots: [],
    onItem: overrides.onItem ?? (() => {}),
    onLoading: () => {},
    getCommandConfirmation: async () => ({ review: "yes" }) as any,
    onLastResponseId: () => {},
    sendResponse: overrides.sendResponse ?? (() => {}),
    config: { model: "any", instructions: "", notify: false },
  });
}

describe("AgentLoop utils", () => {
  it("redirects plain text output to jsonResponse only", async () => {
    const events = [
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "m1",
          content: [{ type: "text", text: "<think>" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp1",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "m1",
              content: [{ type: "text", text: "<think>" }],
            },
          ],
        },
      },
    ];

    const sendSpy = vi.fn();
    const onItem: Array<any> = [];

    const { default: OpenAI } = await import("openai");
    (OpenAI as any).prototype.responses.create = async () => new FakeStream(events);

    const agent = buildAgent({ onItem: (i: any) => onItem.push(i), sendResponse: sendSpy });

    await agent.run([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "do" }],
      },
    ] as any);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0][0];
    expect(typeof payload).toBe("string");
    expect(payload).toContain("<think>");
    const assistantMsg = onItem.find((i) => i.role === "assistant");
    expect(assistantMsg).toBeUndefined();
  });

  it("executes full Rust entry point sequence", async () => {
    const events = [
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call1",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["ls", "-la", "codex-rs"] }),
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call2",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["cat", "codex-rs/Cargo.toml"] }),
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call3",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["ls", "-la", "codex-rs/cli/src"] }),
        },
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call4",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["cat", "codex-rs/cli/src/main.rs"] }),
        },
      },
      {
        type: "response.completed",
        response: { id: "resp2", status: "completed", output: [] },
      },
    ];

    const { default: OpenAI } = await import("openai");
    (OpenAI as any).prototype.responses.create = async () => new FakeStream(events);

    const shellCalls: Array<Array<string>> = [];
    vi.spyOn(handleExec, "handleExecCommand").mockImplementation(async (args: any) => {
      shellCalls.push(args.cmd);
      return { outputText: "", metadata: {} } as any;
    });

    const sendSpy = vi.fn();
    const agent = buildAgent({ sendResponse: sendSpy });

    await agent.run([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "analyze" }],
      },
    ] as any);

    const lastCall = shellCalls[shellCalls.length - 1];
    expect(lastCall).toEqual(["cat", "codex-rs/cli/src/main.rs"]);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("marks jsonResponse partial when sequence is incomplete", async () => {
    const events = [
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call1",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["ls", "-la", "codex-rs"] }),
        },
      },
      {
        type: "response.completed",
        response: { id: "resp3", status: "completed", output: [] },
      },
    ];

    const { default: OpenAI } = await import("openai");
    (OpenAI as any).prototype.responses.create = async () => new FakeStream(events);

    const sendSpy = vi.fn();
    const agent = buildAgent({ sendResponse: sendSpy });

    await agent.run([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "overview" }],
      },
    ] as any);

    const payload = JSON.parse(sendSpy.mock.calls[0][0]);
    expect(payload.status).toMatch(/partial/);
  });

  it("logs command failures and retries", async () => {
    const events = [
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "call1",
          name: "shell",
          arguments: JSON.stringify({ cmd: ["ls", "-la", "codex-rs/src"] }),
        },
      },
      {
        type: "response.completed",
        response: { id: "resp4", status: "completed", output: [] },
      },
    ];

    const { default: OpenAI } = await import("openai");
    (OpenAI as any).prototype.responses.create = async () => new FakeStream(events);

    let attempt = 0;
    vi.spyOn(handleExec, "handleExecCommand").mockImplementation(async () => {
      attempt += 1;
      return { outputText: "ls: cannot access", metadata: { exit_code: 2 } } as any;
    });

    const sendSpy = vi.fn();
    const agent = buildAgent({ sendResponse: sendSpy });

    await agent.run([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "files" }],
      },
    ] as any);

    expect(attempt).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(sendSpy.mock.calls[0][0]);
    expect(payload.errors.length).toBeGreaterThan(0);
  });
});
