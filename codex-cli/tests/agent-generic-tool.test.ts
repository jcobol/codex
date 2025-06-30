import { describe, it, expect, vi } from "vitest";

class FakeStream {
  public controller = { abort: vi.fn() };
  async *[Symbol.asyncIterator]() {
    yield {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "call_custom",
        function: { name: "custom_tool", arguments: "{\"foo\":\"bar\"}" },
      },
    } as any;
    yield {
      type: "response.completed",
      response: {
        id: "resp1",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "call_custom",
            function: { name: "custom_tool", arguments: "{\"foo\":\"bar\"}" },
          },
        ],
      },
    } as any;
  }
}

vi.mock("openai", () => {
  let invocation = 0;
  let capturedSecondBody: any;
  class FakeOpenAI {
    public responses = {
      create: async (body: any) => {
        invocation += 1;
        if (invocation === 1) {
          return new FakeStream();
        }
        if (invocation === 2) {
          capturedSecondBody = body;
          return new (class {
            public controller = { abort: vi.fn() };
            async *[Symbol.asyncIterator]() {}
          })();
        }
        throw new Error("Unexpected additional invocation in test");
      },
    };
  }
  class APIConnectionTimeoutError extends Error {}
  return {
    __esModule: true,
    default: FakeOpenAI,
    APIConnectionTimeoutError,
    _test: { getCapturedSecondBody: () => capturedSecondBody },
  };
});

vi.mock("../src/approvals.js", () => ({
  __esModule: true,
  alwaysApprovedCommands: new Set<string>(),
  canAutoApprove: () => ({ type: "auto-approve", runInSandbox: false }) as any,
  isSafeCommand: () => null,
}));

vi.mock("../src/format-command.js", () => ({
  __esModule: true,
  formatCommandForDisplay: (c: Array<string>) => c.join(" "),
}));

vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: () => {},
  isLoggingEnabled: () => false,
}));

import { AgentLoop } from "../src/utils/agent/agent-loop.js";

describe("generic tool handler", () => {
  it("dispatches unknown tools via generic handler", async () => {
    const { _test } = (await import("openai")) as any;
    const spy = vi
      .spyOn(AgentLoop.prototype as any, "handleGenericToolCall")
      .mockResolvedValue({ outputText: "ok", metadata: {} });

    const agent = new AgentLoop({
      model: "any",
      instructions: "",
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
        content: [{ type: "input_text", text: "run" }],
      },
    ];

    await agent.run(userMsg as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(spy).toHaveBeenCalledTimes(1);
    const body = _test.getCapturedSecondBody();
    expect(body).toBeTruthy();
    const outputItem = body.input?.find((i: any) => i.type === "function_call_output");
    expect(outputItem.output).toContain("ok");
  });
});
