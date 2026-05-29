import { describe, expect, test } from "bun:test"

import type { SessionEvent } from "../src/domain/events"
import { startRun } from "../src/application/start_run"

describe("startRun", () => {
  test("creates a run and stores replayable events", async () => {
    const result = await startRun({
      sessionId: "ses_01",
      input: "hello kokoro",
      executionStyle: "default",
    })

    expect(result.runId).toMatch(/^run_/)
    expect(result.events.at(0)?.event).toBe("run.created")
    expect(result.events.at(-1)?.event).toBe("run.completed")
  })

  test("writes through injected boundaries so application logic stays infrastructure-agnostic", async () => {
    const replayLog: SessionEvent[][] = []
    const streamLog: Array<{ stream: string; event: SessionEvent }> = []

    const result = await startRun(
      {
        sessionId: "ses_02",
        input: "bridge me",
        executionStyle: "default",
      },
      {
        replayStore: {
          append(_sessionId, events) {
            replayLog.push(events)
          },
          read() {
            return []
          },
        },
        streamWriter: {
          async append(stream, event) {
            streamLog.push({ stream, event })
          },
        },
      },
    )

    expect(replayLog).toHaveLength(1)
    expect(replayLog[0]).toEqual(result.events)
    expect(streamLog).toHaveLength(result.events.length)
    expect(streamLog[0]?.stream).toBe("session:ses_02:agent")
    expect(streamLog.at(-1)?.event.event).toBe("run.completed")
  })
})
