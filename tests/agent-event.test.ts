import { describe, expect, test } from "bun:test"

import { agentEventSchema } from "../src/domain/agent-event"

const ENV = { request_id: "run_01", timestamp: 1700000000 }

describe("agentEventSchema", () => {
  test("accepts a well-formed agent_status started event", () => {
    const parsed = agentEventSchema.parse({
      event: "agent_status",
      ...ENV,
      data: { status: "started" },
    })
    expect(parsed.event).toBe("agent_status")
  })

  test("accepts text_chunk with segment_id + text + final", () => {
    const parsed = agentEventSchema.parse({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "hello", final: false },
    })
    if (parsed.event !== "text_chunk") throw new Error("narrowing failed")
    expect(parsed.data.segment_id).toBe("m1")
    expect(parsed.data.text).toBe("hello")
    expect(parsed.data.final).toBe(false)
  })

  test("accepts text_chunk with an optional subagent_id", () => {
    const parsed = agentEventSchema.parse({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "x", final: true, subagent_id: "sa1" },
    })
    if (parsed.event !== "text_chunk") throw new Error("narrowing failed")
    expect(parsed.data.subagent_id).toBe("sa1")
  })

  test("accepts reasoning_chunk", () => {
    const parsed = agentEventSchema.parse({
      event: "reasoning_chunk",
      ...ENV,
      data: { segment_id: "t1", text: "thinking", final: false },
    })
    expect(parsed.event).toBe("reasoning_chunk")
  })

  test("accepts agent_error with error_kind + message", () => {
    const parsed = agentEventSchema.parse({
      event: "agent_error",
      ...ENV,
      data: { error_kind: "timeout", message: "boom" },
    })
    if (parsed.event !== "agent_error") throw new Error("narrowing failed")
    expect(parsed.data.error_kind).toBe("timeout")
  })

  test("accepts agent_done with the terminal status + usage", () => {
    const parsed = agentEventSchema.parse({
      event: "agent_done",
      ...ENV,
      data: { status: "completed", usage: { tokens: 10 } },
    })
    if (parsed.event !== "agent_done") throw new Error("narrowing failed")
    expect(parsed.data.status).toBe("completed")
  })

  test("accepts awaiting_approval with a pending list", () => {
    const parsed = agentEventSchema.parse({
      event: "agent_status",
      ...ENV,
      data: {
        status: "awaiting_approval",
        segment_id: "m1",
        pending: [{ tool_id: "t1", name: "fetch", args: { url: "x" } }],
      },
    })
    expect(parsed.event).toBe("agent_status")
  })

  test("rejects agent_done with a status outside its literal", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "agent_done",
        ...ENV,
        data: { status: "bogus", usage: {} },
      }),
    ).toThrow()
  })

  test("rejects a missing request_id", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "agent_status",
        timestamp: 1,
        data: { status: "started" },
      }),
    ).toThrow()
  })

  test("rejects unknown extra top-level keys (strict)", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "agent_status",
        ...ENV,
        data: { status: "started" },
        injected: "evil",
      }),
    ).toThrow()
  })

  test("rejects unknown event", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "not_an_event",
        ...ENV,
        data: {},
      }),
    ).toThrow()
  })

  test("rejects text_chunk missing text in data", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "text_chunk",
        ...ENV,
        data: { segment_id: "m1", final: false },
      }),
    ).toThrow()
  })

  test("rejects extra keys inside text_chunk data (strict)", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "text_chunk",
        ...ENV,
        data: { segment_id: "m1", text: "x", final: false, smuggled: 1 },
      }),
    ).toThrow()
  })

  test("rejects an unknown agent_status status", () => {
    expect(() =>
      agentEventSchema.parse({
        event: "agent_status",
        ...ENV,
        data: { status: "bogus" },
      }),
    ).toThrow()
  })
})
