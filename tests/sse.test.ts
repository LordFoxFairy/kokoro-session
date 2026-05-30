import { describe, expect, it } from "bun:test"
import { toA2uiSseChunk } from "../src/infrastructure/sse"

describe("toA2uiSseChunk", () => {
  it("emits id + a2ui.op event + json data", () => {
    const op = { version: "v0.9" as const, updateDataModel: { surfaceId: "ses_1", path: "/m", value: "x" } }
    const chunk = toA2uiSseChunk(op, "run_1:0002:0")
    expect(chunk).toBe(`id: run_1:0002:0\nevent: a2ui.op\ndata: ${JSON.stringify(op)}\n\n`)
  })
})
