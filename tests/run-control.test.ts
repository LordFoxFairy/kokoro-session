import { describe, expect, test } from "vitest"

import {
  pendingApprovalsFromEvents,
  resumeDecisionSchema,
  runControlBodySchema,
  validateResumeDecisions,
} from "../src/domain/run-control"
import type { SessionEvent } from "../src/domain/session-event"

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

describe("pendingApprovalsFromEvents", () => {
  const base = {
    event_id: "evt_1",
    seq: 1,
    session_id: "s1",
    conversation_id: "s1",
    run_id: "run_1",
    timestamp: "2026-07-02T00:00:00.000Z",
  }

  function event(event: SessionEvent["event"], payload: Record<string, unknown>): SessionEvent {
    return { ...base, event, payload }
  }

  test("keeps unresolved awaiting approvals for the target run only", () => {
    const pending = pendingApprovalsFromEvents(
      [
        event("tool.awaiting_approval", {
          segment_id: "m1",
          tool_id: "call-A",
          name: "ask_user",
          args: {},
          description: "需要用户回答",
          allowed_decisions: ["respond"],
          kind: "ask_user",
          editable: false,
        }),
        { ...event("tool.awaiting_approval", {
          segment_id: "m1",
          tool_id: "call-B",
          name: "fetch",
          args: {},
          description: "需要批准",
          allowed_decisions: ["approve", "reject"],
          kind: "tool_approval",
          editable: false,
        }), run_id: "other_run" },
      ],
      "run_1",
    )

    expect(pending).toEqual([{ tool_id: "call-A", allowed_decisions: ["respond"] }])
  })

  test("removes an awaiting approval after the matching tool returns", () => {
    const pending = pendingApprovalsFromEvents(
      [
        event("tool.awaiting_approval", {
          segment_id: "m1",
          tool_id: "call-A",
          name: "fetch",
          args: {},
          description: "需要批准",
          allowed_decisions: ["approve", "reject"],
          kind: "tool_approval",
          editable: false,
        }),
        event("tool.returned", {
          segment_id: "m1",
          tool_id: "call-A",
          name: "fetch",
          result: "ok",
          is_error: false,
        }),
      ],
      "run_1",
    )

    expect(pending).toEqual([])
  })
})

describe("validateResumeDecisions", () => {
  test("rejects a decision not allowed by the current pause", () => {
    expect(() =>
      validateResumeDecisions(
        [{ type: "approve", tool_id: "call-A" }],
        [{ tool_id: "call-A", allowed_decisions: ["respond"] }],
      ),
    ).toThrow("not allowed")
  })

  test("requires decisions to exactly match the pending tool ids", () => {
    expect(() =>
      validateResumeDecisions(
        [{ type: "respond", tool_id: "call-A", message: "继续" }],
        [
          { tool_id: "call-A", allowed_decisions: ["respond"] },
          { tool_id: "call-B", allowed_decisions: ["approve", "reject"] },
        ],
      ),
    ).toThrow("missing")
  })

  test("accepts one allowed decision per pending tool", () => {
    expect(() =>
      validateResumeDecisions(
        [
          { type: "respond", tool_id: "call-A", message: "继续" },
          { type: "reject", tool_id: "call-B", message: "不执行" },
        ],
        [
          { tool_id: "call-A", allowed_decisions: ["respond"] },
          { tool_id: "call-B", allowed_decisions: ["approve", "reject"] },
        ],
      ),
    ).not.toThrow()
  })
})
