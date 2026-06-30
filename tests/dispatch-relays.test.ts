import { describe, expect, test } from "bun:test"

import { dispatchRelays } from "../src/application/dispatch-relays"
import { REQUESTS_STREAM, runEventsStream } from "../src/application/stream-names"
import { parseSessionEvent, type SessionEvent } from "../src/domain/session-event"
import { MemoryMessageStore } from "../src/infrastructure/message-store"
import { MemoryStream } from "../src/infrastructure/stream"

function agentRunInput(runId: string) {
  return {
    siteId: "site_1",
    workspaceId: null,
    projectId: null,
    sessionId: "ses_dispatch",
    runId,
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

// relayRun 把归一化信封持久到 MessageStore（长期真源）；从中回读还原已落库的会话事件。
async function readReplay(
  store: MemoryMessageStore,
  sessionId: string,
): Promise<SessionEvent[]> {
  return (await store.read(sessionId)).map((stored) => parseSessionEvent(stored.event))
}

// 轮询直到 replay 出现终态（dispatch 循环活着才可能发生），超时返回当前快照。
async function waitForTerminal(
  read: () => Promise<SessionEvent[]>,
  deadlineMs: number,
): Promise<SessionEvent[]> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const events = await read()
    if (events.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      return events
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return read()
}

describe("dispatchRelays", () => {
  test("a malformed run.request is skipped without killing the dispatch loop", async () => {
    const bus = new MemoryStream()
    const messageStore = new MemoryMessageStore()
    const runId = "run_after_dirty"

    // 先灌一条脏请求（多余键 + 缺必填），再灌合法请求——脏请求不得杀死调度循环。
    await bus.publish(REQUESTS_STREAM, { kind: "run.request", injected: "evil" })
    await bus.publish(REQUESTS_STREAM, {
      kind: "run.request",
      site_id: "site_1",
      run_id: runId,
      session_id: "ses_dispatch",
      agent_run_input: agentRunInput(runId),
    })

    // 合法 run 的 agent 事件已就绪，relay 一启动即可收束。
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await bus.publish(stream, {
      event: "text_chunk",
      ...env,
      data: { segment_id: `${runId}:seg_0001`, text: "still alive", final: true },
    })
    await bus.publish(stream, {
      event: "agent_done",
      ...env,
      data: { status: "completed", usage: {} },
    })

    // 调度循环常驻不返回；悬挂运行后轮询 replay 验证合法 run 仍被调度。
    void dispatchRelays(bus, messageStore).catch(() => {})

    const events = await waitForTerminal(() => readReplay(messageStore, "ses_dispatch"), 1500)
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.completed",
      "run.completed",
    ])
  })
})
