import { describe, expect, test } from "bun:test"

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
})
