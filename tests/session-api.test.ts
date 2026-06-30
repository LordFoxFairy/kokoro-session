import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, test } from "bun:test"

import { REQUESTS_STREAM } from "../src/application/stream-names"
import { runRequestSchema } from "../src/domain/run-request"
import { MemorySessionStore } from "../src/application/session-store"
import { MemoryStream } from "../src/infrastructure/stream"
import { buildServer } from "../src/interfaces/http"

function makeDeps() {
  let messageNumber = 0
  let runNumber = 0
  const bus = new MemoryStream()
  const sessionStore = new MemorySessionStore({
    now: () => new Date("2026-06-30T00:00:00.000Z"),
    newMessageId: () => `msg_${++messageNumber}`,
    newRunId: () => `run_${++runNumber}`,
  })
  return { bus, sessionStore }
}

let server: ReturnType<typeof buildServer> | undefined
let baseUrl = ""

async function listen(deps: ReturnType<typeof makeDeps>) {
  server = buildServer(deps)
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server?.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
}

async function postMessage(sessionId: string, body: unknown, headers?: HeadersInit): Promise<Response> {
  return fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kokoro-site-id": "site_1", ...headers },
    body: JSON.stringify(body),
  })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
})

describe("message-first session API", () => {
  test("POST /sessions/:id/messages creates a run", async () => {
    const deps = makeDeps()
    await listen(deps)

    const res = await postMessage(
      "ses_1",
      {
        idempotencyKey: "idem_1",
        content: "hello",
        executionStyle: "thinking",
        permissionMode: "default",
        selectedSkillIds: ["skill_a"],
        selectedMcpServerIds: ["mcp_a"],
        selectedToolNames: ["web_fetch"],
      },
      { "x-kokoro-user-id": "user_1" },
    )

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toEqual({
      messageId: "msg_1",
      assistantMessageId: "msg_2",
      runId: "run_1",
    })
    const requests = await deps.bus.readAll(REQUESTS_STREAM)
    expect(requests).toHaveLength(1)
    const request = runRequestSchema.parse(requests[0]?.event)
    expect(request).toMatchObject({
      kind: "run.request",
      site_id: "site_1",
      session_id: "ses_1",
      run_id: "run_1",
      agent_run_input: {
        siteId: "site_1",
        sessionId: "ses_1",
        runId: "run_1",
        userId: "user_1",
        inputMessageId: "msg_1",
        assistantMessageId: "msg_2",
        executionStyle: "thinking",
        permissionMode: "default",
        enabledSkills: ["skill_a"],
        enabledMcpServers: ["mcp_a"],
        enabledTools: ["web_fetch"],
      },
    })
  })

  test("POST /sessions/:id/messages returns same run for same idempotencyKey", async () => {
    const deps = makeDeps()
    await listen(deps)

    const body = { idempotencyKey: "idem_1", content: "hello" }
    const first = await postMessage("ses_1", body)
    const retry = await postMessage("ses_1", body)

    expect(first.status).toBe(202)
    expect(retry.status).toBe(202)
    await expect(retry.json()).resolves.toEqual(await first.json())
  })

  test("POST /sessions/:id/messages rejects second active run", async () => {
    const deps = makeDeps()
    await listen(deps)

    await postMessage("ses_1", { idempotencyKey: "idem_1", content: "hello" })
    const rejected = await postMessage("ses_1", { idempotencyKey: "idem_2", content: "again" })

    expect(rejected.status).toBe(409)
    await expect(deps.sessionStore.listRuns("site_1", "ses_1")).resolves.toHaveLength(1)
  })

  test("GET /sessions/:id returns snapshot with eventWatermark", async () => {
    const deps = makeDeps()
    await listen(deps)
    await postMessage("ses_1", { idempotencyKey: "idem_1", content: "hello" })
    await deps.sessionStore.appendEvent({
      siteId: "site_1",
      sessionId: "ses_1",
      eventId: "evt_1",
      conversationId: "ses_1",
      runId: "run_1",
      type: "message.delta",
      timestamp: "2026-06-30T00:00:00.000Z",
      payload: { delta: "hi" },
    })

    const res = await fetch(`${baseUrl}/sessions/ses_1`, {
      headers: { "x-kokoro-site-id": "site_1" },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      eventWatermark: string | null
      messages: unknown[]
      runs: unknown[]
      events: unknown[]
    }
    expect(body.eventWatermark).toBe("evt_1")
    expect(body.messages).toHaveLength(2)
    expect(body.runs).toHaveLength(1)
    expect(body.events).toHaveLength(1)
  })

  test("old POST /sessions/:id/runs route is removed", async () => {
    const deps = makeDeps()
    await listen(deps)

    const res = await fetch(`${baseUrl}/sessions/ses_1/runs?input=hello`, { method: "POST" })

    expect(res.status).toBe(404)
  })
})
