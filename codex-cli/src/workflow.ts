import type { AgentLoop } from "./utils/agent/agent-loop.js";
import type { ResponseInputItem } from "openai/resources/responses/responses";

export interface WorkflowPhase {
  name: string;
  run: (
    agent: AgentLoop,
    input: Array<ResponseInputItem>,
    previousResponseId: string,
  ) => Promise<void>;
}

export type Workflow = ReadonlyArray<WorkflowPhase>;

export async function runWorkflow(
  workflow: Workflow,
  agent: AgentLoop,
  input: Array<ResponseInputItem>,
  previousResponseId = "",
): Promise<void> {
  const lastId = previousResponseId;
  for (const phase of workflow) {
    // eslint-disable-next-line no-await-in-loop -- workflow phases run sequentially
    await phase.run(agent, input, lastId);
  }
}

export const defaultWorkflow: Workflow = [
  {
    name: "default",
    async run(
      agent: AgentLoop,
      input: Array<ResponseInputItem>,
      lastId: string,
    ): Promise<void> {
      await agent.run(input, lastId);
    },
  },
];
