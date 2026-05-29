import type { SessionEvent } from "../domain/events"
import type { StartRunInput } from "../domain/sessions"
import type { AgentRunStreamClient, SessionReplayStore } from "./ports"
import { createAgentRunStreamClient } from "../infrastructure/agent_client"
import { memoryReplayStore } from "../infrastructure/replay_store"

export type StartRunDependencies = {
  replayStore: SessionReplayStore
  agentClient: AgentRunStreamClient
}

const defaultDependencies: StartRunDependencies = {
  replayStore: memoryReplayStore,
  agentClient: createAgentRunStreamClient({
    baseUrl: process.env.KOKORO_AGENT_BASE_URL ?? "http://127.0.0.1:8001",
  }),
}

export async function startRun(
  input: StartRunInput,
  dependencies: StartRunDependencies = defaultDependencies,
) {
  const events: SessionEvent[] = []

  for await (const event of dependencies.agentClient.streamRun(input)) {
    events.push(event)
  }

  dependencies.replayStore.append(input.sessionId, events)

  return {
    runId: events.at(0)?.run_id ?? "",
    events,
  }
}
