import { describe, expect, test } from "vitest"

import { runRequestSchema } from "../src/domain/run-request"

function agentRunInput() {
  return {
    siteId: "site_1",
    workspaceId: null,
    projectId: null,
    sessionId: "ses_01",
    runId: "run_01",
    userId: "user_1",
    inputMessageId: "msg_1",
    assistantMessageId: "msg_2",
    context: {
      recentMessages: [{ messageId: "msg_1", role: "user", content: "hello" }],
      summary: null,
      artifactRefs: [],
      toolResultRefs: [],
      userProvidedFiles: [],
    },
    modelRuntime: { provider: "default", model: "default" },
    executionStyle: "fast",
    permissionMode: "auto",
    backendPolicy: { backend: "default" },
    enabledSkills: [],
    enabledMcpServers: [],
    enabledTools: [],
    traceContext: { requestId: "idem_1" },
  }
}

describe("runRequestSchema", () => {
  test("accepts a well-formed run.request", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      site_id: "site_1",
      run_id: "run_01",
      session_id: "ses_01",
      agent_run_input: agentRunInput(),
    })
    expect(parsed.agent_run_input.context.recentMessages[0]?.content).toBe("hello")
    expect(parsed.agent_run_input.executionStyle).toBe("fast")
  })

  test("accepts thinking executionStyle inside agent_run_input", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      site_id: "site_1",
      run_id: "run_01",
      session_id: "ses_01",
      agent_run_input: { ...agentRunInput(), executionStyle: "thinking" },
    })
    expect(parsed.agent_run_input.executionStyle).toBe("thinking")
  })

  test("rejects executionStyle outside fast/thinking", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        site_id: "site_1",
        run_id: "run_01",
        session_id: "ses_01",
        agent_run_input: { ...agentRunInput(), executionStyle: "default" },
      }),
    ).toThrow()
  })

  test("accepts permissionMode inside agent_run_input", () => {
    const parsed = runRequestSchema.parse({
      kind: "run.request",
      site_id: "site_1",
      run_id: "run_01",
      session_id: "ses_01",
      agent_run_input: { ...agentRunInput(), permissionMode: "plan" },
    })
    expect(parsed.agent_run_input.permissionMode).toBe("plan")
  })

  test("rejects permissionMode outside auto/default/plan", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        site_id: "site_1",
        run_id: "run_01",
        session_id: "ses_01",
        agent_run_input: { ...agentRunInput(), permissionMode: "bogus" },
      }),
    ).toThrow()
  })

  test("requires agent_run_input", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        site_id: "site_1",
        run_id: "run_01",
        session_id: "ses_01",
      }),
    ).toThrow()
  })

  test("rejects extra keys (strict)", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.request",
        site_id: "site_1",
        run_id: "run_01",
        session_id: "ses_01",
        agent_run_input: agentRunInput(),
        rogue: true,
      }),
    ).toThrow()
  })

  test("rejects wrong kind literal", () => {
    expect(() =>
      runRequestSchema.parse({
        kind: "run.started",
        site_id: "site_1",
        run_id: "run_01",
        session_id: "ses_01",
        agent_run_input: agentRunInput(),
      }),
    ).toThrow()
  })
})
