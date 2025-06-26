import { describe, it, expect, vi } from "vitest";

class FakeStream {
  public controller = { abort: vi.fn() };
  async *[Symbol.asyncIterator]() {
    yield {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "call_last",
        name: "last_response",
        arguments: "{}",
      },
    } as any;
    yield {
      type: "response.completed",
      response: {
        id: "resp_last",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "call_last",
            name: "last_response",
            arguments: "{}",
          },
        ],
      },
    } as any;
  }
}

let callCount = 0;
vi.mock("openai", () => {
  class FakeOpenAI {
    public responses = {
      create: async () => {
        callCount += 1;
        if (callCount > 1) {
          throw new Error("unexpected extra call");
        }
        return new FakeStream();
      },
    };
  }
  class APIConnectionTimeoutError extends Error {}
  return { __esModule: true, default: FakeOpenAI, APIConnectionTimeoutError, _test: { getCallCount: () => callCount } };
});

vi.mock("../src/approvals.js", () => ({
  __esModule: true,
  alwaysApprovedCommands: new Set<string>(),
  canAutoApprove: () => ({ type: "auto-approve", runInSandbox: false }) as any,
  isSafeCommand: () => null,
}));

vi.mock("../src/format-command.js", () => ({
  __esModule: true,
  formatCommandForDisplay: (cmd: Array<string>) => cmd.join(" "),
}));

vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: () => {},
  isLoggingEnabled: () => false,
}));

import { AgentLoop } from "../src/utils/agent/agent-loop.js";

describe("last_response tool", () => {
  it("stops further iterations when invoked", async () => {
    const { _test } = (await import("openai")) as any;

    const agent = new AgentLoop({
      model: "any",
      instructions: "",
      config: { model: "any", instructions: "", notify: false },
      approvalPolicy: { mode: "auto" } as any,
      additionalWritableRoots: [],
      onItem: () => {},
      onLoading: () => {},
      getCommandConfirmation: async () => ({ review: "yes" }) as any,
      onLastResponseId: () => {},
    });

    const userMsg = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ];

    await agent.run(userMsg as any);

    await new Promise((r) => setTimeout(r, 20));

    expect(_test.getCallCount()).toBe(1);
  });
});
