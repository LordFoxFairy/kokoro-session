import { randomUUID } from "node:crypto"

import type { SessionEvent } from "../domain/events"
import type { StartRunInput } from "../domain/sessions"
import type { AgentEventStreamWriter, SessionReplayStore } from "./ports"
import { memoryReplayStore } from "../infrastructure/replay_store"
import { memoryStreamWriter } from "../infrastructure/redis_stream"

export type StartRunDependencies = {
  replayStore: SessionReplayStore
  streamWriter: AgentEventStreamWriter
}

const defaultDependencies: StartRunDependencies = {
  replayStore: memoryReplayStore,
  streamWriter: memoryStreamWriter,
}

export async function startRun(
  input: StartRunInput,
  dependencies: StartRunDependencies = defaultDependencies,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`
  const stream = `session:${input.sessionId}:agent`
  const events: SessionEvent[] = [
    { event: "run.created", runId },
    { event: "message.delta", runId, delta: `Kokoro received: ${input.input}` },
    { event: "message.completed", runId, content: `Kokoro received: ${input.input}` },
    { event: "run.completed", runId },
  ]

  for (const event of events) {
    await dependencies.streamWriter.append(stream, event)
  }

  dependencies.replayStore.append(input.sessionId, events)

  return { runId, events }
}
