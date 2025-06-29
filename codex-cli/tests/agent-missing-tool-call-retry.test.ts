import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers & mocks
// ---------------------------------------------------------------------------

function createStream(events: Array<any>) {
  return new (class {
    public controller = { abort: vi.fn() };
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        yield ev;
      }
    }
  })();
}

const openAiState: { createSpy?: ReturnType<typeof vi.fn> } = {};

vi.mock("openai", () => {
  class FakeOpenAI {
    public responses = {
      create: (...args: Array<any>) => openAiState.createSpy!(...args),
    };
  }

  class APIConnectionTimeoutError extends Error {}

  return {
    __esModule: true,
    default: FakeOpenAI,
    APIConnectionTimeoutError,
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

import { AgentLoop } from "../src/utils/agent/agent-loop.ts";

describe("AgentLoop – retry when missing tool call", () => {
  it("retries the request if no tool call is returned", async () => {
    let call = 0;
    openAiState.createSpy = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return createStream([
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: "m1",
              content: [{ type: "text", text: "ok" }],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "r1",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  id: "m1",
                  content: [{ type: "text", text: "ok" }],
                },
              ],
            },
          },
        ]);
      }
      if (call === 2) {
        return createStream([
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "call1",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: ["echo", "hi"] }),
              },
            },
          },
          {
            type: "response.completed",
            response: {
              id: "r2",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "call1",
                  function: {
                    name: "shell",
                    arguments: JSON.stringify({ cmd: ["echo", "hi"] }),
                  },
                },
              ],
            },
          },
        ]);
      }
      throw new Error("unexpected extra call");
    });

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
        content: [{ type: "input_text", text: "hi" }],
      },
    ];

    await agent.run(userMsg as any);

    await new Promise((r) => setTimeout(r, 20));

    expect(openAiState.createSpy).toHaveBeenCalledTimes(2);
  });
});

