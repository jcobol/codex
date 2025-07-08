import { describe, it, expect, vi, afterAll } from "vitest";
const ORIGINAL_SKIP = process.env.SKIP_PLAN_GENERATION;
delete process.env.SKIP_PLAN_GENERATION;
import { AgentLoop } from "../src/utils/agent/agent-loop.js";

class PlanStream {
  public controller = { abort: vi.fn() };
  async *[Symbol.asyncIterator]() {
    yield {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "plan" }],
      },
    } as any;
    yield {
      type: "response.completed",
      response: { id: "plan", status: "completed", output: [] },
    } as any;
  }
}

class DoneStream {
  public controller = { abort: vi.fn() };
  async *[Symbol.asyncIterator]() {
    yield {
      type: "response.completed",
      response: {
        id: "resp",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "text", text: "done" }] }],
      },
    } as any;
  }
}

vi.mock("openai", () => {
  let calls = 0;
  return {
    __esModule: true,
    default: class FakeOpenAI {
      public responses = {
        create: async () => {
          calls += 1;
          return calls === 1 ? new PlanStream() : new DoneStream();
        },
      };
    },
    APIConnectionTimeoutError: class extends Error {},
  };
});

vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: () => {},
  isLoggingEnabled: () => false,
}));

vi.mock("../src/approvals.js", () => ({
  __esModule: true,
  alwaysApprovedCommands: new Set<string>(),
  canAutoApprove: () => ({ type: "auto-approve", runInSandbox: false }) as any,
  isSafeCommand: () => null,
}));

describe("planning", () => {
  it("emits plan before executing", async () => {
    const items: Array<any> = [];
    const agent = new AgentLoop({
      model: "any",
      instructions: "",
      approvalPolicy: { mode: "auto" } as any,
      additionalWritableRoots: [],
      onItem: (i) => items.push(i),
      onLoading: () => {},
      getCommandConfirmation: async () => ({ review: "yes" }) as any,
      onLastResponseId: () => {},
    });

    const userMsg = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];

    await agent.run(userMsg as any);
    await new Promise((r) => setTimeout(r, 20));

    expect(items[0]?.content?.[0]?.text).toBe("plan");
    expect(items[1]?.content?.[0]?.text).toBe("done");
  });

  afterAll(() => {
    if (ORIGINAL_SKIP !== undefined) {
      process.env.SKIP_PLAN_GENERATION = ORIGINAL_SKIP;
    } else {
      delete process.env.SKIP_PLAN_GENERATION;
    }
  });
});
