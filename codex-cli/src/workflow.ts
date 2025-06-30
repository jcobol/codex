export type WorkflowPhase = {
  name: string;
  run: (
    agent: import("./utils/agent/agent-loop.js").AgentLoop,
    input: Array<import("openai/resources/responses/responses.js").ResponseInputItem>,
    previousResponseId: string,
  ) => Promise<void>;
};

export type Workflow = ReadonlyArray<WorkflowPhase>;

export async function runWorkflow(
  workflow: Workflow,
  agent: import("./utils/agent/agent-loop.js").AgentLoop,
  input: Array<import("openai/resources/responses/responses.js").ResponseInputItem>,
  previousResponseId = "",
): Promise<void> {
  let lastId = previousResponseId;
  for (const phase of workflow) {
    await phase.run(agent, input, lastId);
  }
}

export const defaultWorkflow: Workflow = [
  {
    name: "default",
    async run(agent, input, lastId) {
      await agent.run(input, lastId);
    },
  },
];
