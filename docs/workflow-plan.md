# Workflow design

This document outlines how to introduce a configurable workflow into Codex CLI's request handling.

## 1. Understand the current structure

- **CLI entry**: `codex-cli/src/cli.tsx` sets up the `AgentLoop` and runs user requests.
- **Agent loop**: `codex-cli/src/utils/agent/agent-loop.ts` submits prompts, streams model output and handles tool calls.
- **Rust backend**: `codex-rs/core/src/codex.rs` implements `run_turn` and `handle_response_item` for executing shell commands and applying patches.
- **Protocol types**: `codex-rs/core/src/protocol.rs` defines request and response structures.

## 2. Map the workflow to existing flows

Requests originate in the CLI. `AgentLoop.run` sends input to the backend via `Session::run_turn`. The backend streams events and handles function calls. A workflow would orchestrate these phases: analysis, command execution and patch application.

## 3. Plan for a workflow module

1. **Define phases**
   - Create a new module (e.g. `codex-cli/src/workflow.ts`) describing ordered phases like `analyze`, `execute`, `generate_patches`.
   - Each phase specifies a handler that can issue prompts, wait for approvals or run commands.
2. **Integrate with AgentLoop**
   - Pass the workflow definition when creating an `AgentLoop` instance.
   - `AgentLoop.run` iterates through the phases, delegating to the workflow module to determine what inputs to send next.
3. **Session support**
   - Extend `codex-rs/core/src/codex.rs` to accept workflow metadata (such as the current phase) when running a turn.
   - Use the metadata to drive the backend logic if certain phases should behave differently.
4. **Configuration**
   - Expose a CLI flag or configuration file section to select predefined workflows or provide a custom sequence.

This design keeps backward compatibility (no workflow means the existing behaviour) while allowing advanced orchestration of request handling.
