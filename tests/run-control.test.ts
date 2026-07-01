import { describe, expect, test } from "vitest"

import {
  resumeDecisionSchema,
  runControlBodySchema,
} from "../src/domain/run-control"

// 镜像 kokoro-agent inbound.py 的 ResumeDecision 判别联合：各型按 type、必带 tool_id、strict。
describe("resumeDecisionSchema", () => {
  test("accepts approve with tool_id", () => {
    expect(resumeDecisionSchema.parse({ type: "approve", tool_id: "t1" })).toEqual({
      type: "approve",
      tool_id: "t1",
    })
  })

  test("accepts edit with edited_action", () => {
    const edited = { name: "bash", args: { cmd: "ls" } }
    expect(
      resumeDecisionSchema.parse({ type: "edit", tool_id: "t1", edited_action: edited }),
    ).toEqual({ type: "edit", tool_id: "t1", edited_action: edited })
  })

  test.each(["reject", "respond"] as const)("accepts %s with message", (type) => {
    expect(resumeDecisionSchema.parse({ type, tool_id: "t1", message: "m" })).toEqual({
      type,
      tool_id: "t1",
      message: "m",
    })
  })

  test("rejects a decision missing tool_id (multi-tool attribution required)", () => {
    expect(() => resumeDecisionSchema.parse({ type: "approve" })).toThrow()
  })

  test.each(["reject", "respond"] as const)("rejects %s missing message", (type) => {
    expect(() => resumeDecisionSchema.parse({ type, tool_id: "t1" })).toThrow()
  })

  test("rejects an unknown decision type (fails loud)", () => {
    expect(() => resumeDecisionSchema.parse({ type: "nuke", tool_id: "t1" })).toThrow()
  })

  test("rejects extra keys on approve (strict boundary)", () => {
    expect(() =>
      resumeDecisionSchema.parse({ type: "approve", tool_id: "t1", extra: 1 }),
    ).toThrow()
  })
})

describe("runControlBodySchema", () => {
  test("accepts a cancel body", () => {
    expect(runControlBodySchema.parse({ kind: "run.cancel" })).toEqual({ kind: "run.cancel" })
  })

  test("accepts a resume body with same-frame multi-tool decisions", () => {
    const body = {
      kind: "run.resume" as const,
      decisions: [
        { type: "approve" as const, tool_id: "call-A" },
        { type: "reject" as const, tool_id: "call-B", message: "no" },
      ],
    }
    expect(runControlBodySchema.parse(body)).toEqual(body)
  })

  test("rejects an empty decisions array (a resume must decide ≥1 tool)", () => {
    expect(() => runControlBodySchema.parse({ kind: "run.resume", decisions: [] })).toThrow()
  })

  test("rejects a run_id in the body (injected from the URL path, not the client)", () => {
    expect(() =>
      runControlBodySchema.parse({
        kind: "run.resume",
        run_id: "spoofed",
        decisions: [{ type: "approve", tool_id: "t1" }],
      }),
    ).toThrow()
  })
})
