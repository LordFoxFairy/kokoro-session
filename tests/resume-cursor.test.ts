import { describe, expect, test } from "bun:test"

import { resumeEventId } from "../src/interfaces/sse-endpoint"

describe("resumeEventId", () => {
  test("accepts an opaque SSE event id", () => {
    expect(resumeEventId("evt_abc123")).toBe("evt_abc123")
  })

  test("does not parse or sort the id", () => {
    expect(resumeEventId("evt_not_ordered")).toBe("evt_not_ordered")
  })

  test("rejects a header array", () => {
    expect(resumeEventId(["1", "2"])).toBeUndefined()
  })

  test("rejects undefined and empty", () => {
    expect(resumeEventId(undefined)).toBeUndefined()
    expect(resumeEventId("")).toBeUndefined()
  })
})
