import { describe, expect, test } from "bun:test"

import { agentEventSchema } from "../src/domain/agent-event"

describe("agentEventSchema", () => {
  test("accepts a well-formed run.started event", () => {
    const parsed = agentEventSchema.parse({
      kind: "run.started",
      run_id: "run_01",
      seq: 1,
      payload: {},
    })
    expect(parsed.kind).toBe("run.started")
    expect(parsed.seq).toBe(1)
  })

  test("accepts text.delta with message_ref + text payload", () => {
    const parsed = agentEventSchema.parse({
      kind: "text.delta",
      run_id: "run_01",
      seq: 2,
      payload: { message_ref: "m1", text: "hello" },
    })
    if (parsed.kind !== "text.delta") throw new Error("narrowing failed")
    expect(parsed.payload.message_ref).toBe("m1")
    expect(parsed.payload.text).toBe("hello")
  })

  test("accepts run.failed with error_kind + message", () => {
    const parsed = agentEventSchema.parse({
      kind: "run.failed",
      run_id: "run_01",
      seq: 9,
      payload: { error_kind: "timeout", message: "boom" },
    })
    if (parsed.kind !== "run.failed") throw new Error("narrowing failed")
    expect(parsed.payload.error_kind).toBe("timeout")
  })

  test("rejects a missing seq", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "run.started",
        run_id: "run_01",
        payload: {},
      }),
    ).toThrow()
  })

  test("rejects unknown extra top-level keys (strict)", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "run.started",
        run_id: "run_01",
        seq: 1,
        payload: {},
        injected: "evil",
      }),
    ).toThrow()
  })

  test("rejects unknown kind", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "not.a.kind",
        run_id: "run_01",
        seq: 1,
        payload: {},
      }),
    ).toThrow()
  })

  test("rejects non-integer seq", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "run.started",
        run_id: "run_01",
        seq: 1.5,
        payload: {},
      }),
    ).toThrow()
  })

  test("rejects text.delta missing text in payload", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "text.delta",
        run_id: "run_01",
        seq: 2,
        payload: { message_ref: "m1" },
      }),
    ).toThrow()
  })

  test("rejects extra keys inside text.delta payload (strict)", () => {
    expect(() =>
      agentEventSchema.parse({
        kind: "text.delta",
        run_id: "run_01",
        seq: 2,
        payload: { message_ref: "m1", text: "x", smuggled: 1 },
      }),
    ).toThrow()
  })
})
