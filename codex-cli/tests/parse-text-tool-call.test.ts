import { describe, it, expect } from "vitest";
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
