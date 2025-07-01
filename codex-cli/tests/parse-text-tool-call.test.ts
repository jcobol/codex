import { describe, it, expect, vi } from "vitest";

vi.mock("openai", () => {
  class FakeOpenAI {
    public responses = {
      create: () => ({
        controller: { abort: vi.fn() },
        async *[Symbol.asyncIterator]() {}
      }),
    };
  }
  class APIConnectionTimeoutError extends Error {}
  return { __esModule: true, default: FakeOpenAI, APIConnectionTimeoutError };
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

function createAgent() {
  return new AgentLoop({
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
}

describe("parseTextToolCall", () => {
  it("parses JSON tool call followed by explanation", () => {
    const agent = createAgent();
    const text = '{"cmd":["echo","hi"]}\nMore info';
    const parsed = (agent as any).parseTextToolCall(text);
    expect(parsed).toMatchObject({
      type: "local_shell_call",
      action: { command: ["echo", "hi"] },
    });
  });
});
