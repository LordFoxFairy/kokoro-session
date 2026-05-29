import { randomUUID } from "node:crypto"

import type { SessionEvent } from "../domain/events"
import type { StartRunInput } from "../domain/sessions"
import { memoryReplayStore } from "../infrastructure/replay_store"
import { memoryStreamWriter } from "../infrastructure/redis_stream"

export async function startRun(input: StartRunInput) {
  const runId = `run_${randomUUID().slice(0, 8)}`
  const stream = `session:${input.sessionId}:agent`
  const events: SessionEvent[] = [
    { event: "run.created", runId },
    { event: "message.delta", runId, delta: `Kokoro received: ${input.input}` },
    { event: "message.completed", runId, content: `Kokoro received: ${input.input}` },
    { event: "run.completed", runId },
  ]

  for (const event of events) {
    await memoryStreamWriter.append(stream, event)
  }

  memoryReplayStore.append(input.sessionId, events)

  return { runId, events }
}
