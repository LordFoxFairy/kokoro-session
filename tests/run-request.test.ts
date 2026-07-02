import { describe, expect, test } from "vitest"

import { runRequestSchema } from "../src/domain/run-request"

describe("runRequestSchema", () => {
  test("accepts a well-formed run.request", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      run_id: "run_01",
      session_id: "ses_01",
      conversation_id: "conv_01",
      input: "hello",
    })
    expect(parsed.input).toBe("hello")
    expect(parsed.execution_style).toBeUndefined()
  })

  test("accepts optional execution_style", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      run_id: "run_01",
      session_id: "ses_01",
      conversation_id: "conv_01",
      input: "hello",
      execution_style: "thinking",
    })
    expect(parsed.execution_style).toBe("thinking")
  })

  test("rejects execution_style outside fast/thinking", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        run_id: "run_01",
        session_id: "ses_01",
        conversation_id: "conv_01",
        input: "hello",
        execution_style: "default",
      }),
    ).toThrow()
  })

  test("accepts optional permission_mode", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      run_id: "run_01",
      session_id: "ses_01",
      conversation_id: "conv_01",
      input: "hello",
      permission_mode: "plan",
    })
    expect(parsed.permission_mode).toBe("plan")
  })

  test("rejects permission_mode outside auto/default/plan", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        run_id: "run_01",
        session_id: "ses_01",
        conversation_id: "conv_01",
        input: "hello",
        permission_mode: "bogus",
      }),
    ).toThrow()
  })

  test("requires input", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        run_id: "run_01",
        session_id: "ses_01",
        conversation_id: "conv_01",
      }),
    ).toThrow()
  })

  test("rejects extra keys (strict)", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        run_id: "run_01",
        session_id: "ses_01",
        conversation_id: "conv_01",
        input: "hello",
        rogue: true,
      }),
    ).toThrow()
  })

  test("rejects wrong kind literal", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.started",
        run_id: "run_01",
        session_id: "ses_01",
        conversation_id: "conv_01",
        input: "hello",
      }),
    ).toThrow()
  })
})
