import { describe, expect, it } from "bun:test"
import { a2uiOpSchema, type A2uiOp } from "../src/domain/a2ui"

describe("a2uiOpSchema", () => {
  it("accepts createSurface", () => {
    const op = { version: "v0.9", createSurface: { surfaceId: "ses_1", catalogId: "kokoro/chat/v1" } }
    expect(a2uiOpSchema.parse(op)).toEqual(op)
  })

  it("accepts updateComponents with passthrough component props", () => {
    const op = {
      version: "v0.9",
      updateComponents: {
        surfaceId: "ses_1",
        components: [{ id: "root", component: "Thread", children: ["m_1"] }],
      },
    }
    expect(a2uiOpSchema.parse(op)).toEqual(op)
  })

  it("accepts updateDataModel", () => {
    const op = { version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/m_1", value: "hi" } }
    expect(a2uiOpSchema.parse(op)).toEqual(op)
  })

  it("rejects wrong version", () => {
    expect(() => a2uiOpSchema.parse({ version: "v1", createSurface: { surfaceId: "s", catalogId: "c" } })).toThrow()
  })

  it("rejects component missing id/component", () => {
    expect(() =>
      a2uiOpSchema.parse({ version: "v0.9", updateComponents: { surfaceId: "s", components: [{ id: "x" }] } }),
    ).toThrow()
  })

  it("infers A2uiOp union", () => {
    const op: A2uiOp = { version: "v0.9", updateDataModel: { surfaceId: "s", path: "/a", value: 1 } }
    expect(op.version).toBe("v0.9")
  })
})
