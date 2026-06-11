import { describe, expect, test } from "bun:test"

import { resumeCursor } from "../src/interfaces/http"

// resumeCursor 决定 Last-Event-ID 能否作续点：仅传输层游标格式（memory 纯数字 / redis "ms-seq"）
// 才续传，域 cursor 或畸形值退回全量重放（eventId 去重兜底）。
describe("resumeCursor", () => {
  test("accepts a memory transport cursor (zero-padded digits)", () => {
    expect(resumeCursor("00000000000000000001")).toBe("00000000000000000001")
  })

  test("accepts a redis stream id (ms-seq)", () => {
    expect(resumeCursor("1718000000000-0")).toBe("1718000000000-0")
  })

  test("rejects a domain envelope cursor (run-scoped) → full replay", () => {
    expect(resumeCursor("run_x:0001")).toBeUndefined()
  })

  test("rejects a header array", () => {
    expect(resumeCursor(["1", "2"])).toBeUndefined()
  })

  test("rejects undefined and empty", () => {
    expect(resumeCursor(undefined)).toBeUndefined()
    expect(resumeCursor("")).toBeUndefined()
  })
})
