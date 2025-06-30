import { describe, it, expect } from "vitest";
import { runWorkflow, defaultWorkflow } from "../src/workflow.js";

// Simple stub agent that records calls to run()
class StubAgent {
  public calls: Array<{ input: any; lastId: string }> = [];
  async run(input: any, lastId: string) {
    this.calls.push({ input, lastId });
  }
}

describe("workflow", () => {
  it("executes phases in order", async () => {
    const order: Array<string> = [];
    const phases = [
      {
        name: "first",
        async run() {
          order.push("first");
        },
      },
      {
        name: "second",
        async run() {
          order.push("second");
        },
      },
    ];
    await runWorkflow(phases, {} as any, [], "id1");
    expect(order).toEqual(["first", "second"]);
  });

  it("defaultWorkflow runs agent", async () => {
    const agent = new StubAgent();
    const input = ["dummy"] as any;
    await runWorkflow(defaultWorkflow, agent as any, input, "prev");
    expect(agent.calls).toEqual([{ input, lastId: "prev" }]);
  });
});
