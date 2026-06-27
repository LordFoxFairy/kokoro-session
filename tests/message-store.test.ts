import { rmSync } from "node:fs"

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"

import type { MessageStore } from "../src/application/event-stream"
import type { SessionEvent } from "../src/domain/session-event"
import {
  makeMessageStore,
  MemoryMessageStore,
  SqliteMessageStore,
} from "../src/infrastructure/message-store"

function evt(sessionId: string, seq: number, eventId: string): SessionEvent {
  // 最简合法 SessionEvent（run.created）；read 的出库 Zod 必须能过。
  return {
    event: "run.created",
    event_id: eventId,
    seq,
    session_id: sessionId,
    conversation_id: sessionId,
    run_id: "run_1",
    timestamp: "2026-05-30T00:00:00.000Z",
    payload: { run_id: "run_1" },
  }
}

// 行为矩阵：append/read 往返按 seq 有序、event_id 幂等去重、afterSeq 增量、limit、会话隔离。
async function assertBehaviour(store: MessageStore): Promise<void> {
  const sid = "ses_a"
  await store.append(sid, [evt(sid, 0, "e0"), evt(sid, 1, "e1"), evt(sid, 2, "e2")])
  expect((await store.read(sid)).map((e) => e.event_id)).toEqual(["e0", "e1", "e2"])

  // 重复 event_id 幂等：再 append 同一条只存一次。
  await store.append(sid, [evt(sid, 1, "e1")])
  expect((await store.read(sid)).length).toBe(3)

  // afterSeq 增量回放（SSE 从历史接实时的桥）。
  expect((await store.read(sid, { afterSeq: 0 })).map((e) => e.seq)).toEqual([1, 2])

  // limit 分页。
  expect((await store.read(sid, { limit: 2 })).map((e) => e.event_id)).toEqual(["e0", "e1"])

  // 会话隔离：read 按 sessionId 只取自己的；未知会话 → []。
  expect(await store.read("ses_other")).toEqual([])
}

describe("MessageStore 行为矩阵", () => {
  test("memory", async () => {
    await assertBehaviour(new MemoryMessageStore())
  })

  test("sqlite", async () => {
    await assertBehaviour(new SqliteMessageStore(new Database(":memory:")))
  })
})

describe("SqliteMessageStore 落盘持久性", () => {
  const path = `/tmp/kokoro-msg-${crypto.randomUUID()}.db`
  afterEach(() => {
    for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true })
  })

  test("跨句柄/重启读同一文件（持久历史不丢）", async () => {
    const writer = new SqliteMessageStore(new Database(path))
    await writer.append("s", [evt("s", 0, "x"), evt("s", 1, "y")])
    // 全新句柄（模拟重启 / 另一进程）读同一文件。
    const reader = new SqliteMessageStore(new Database(path))
    expect((await reader.read("s")).map((e) => e.event_id)).toEqual(["x", "y"])
  })
})

describe("makeMessageStore 工厂", () => {
  const origBackend = process.env.KOKORO_MESSAGE_STORE_BACKEND
  const origDb = process.env.KOKORO_MESSAGE_STORE_DB

  afterEach(() => {
    if (origBackend === undefined) delete process.env.KOKORO_MESSAGE_STORE_BACKEND
    else process.env.KOKORO_MESSAGE_STORE_BACKEND = origBackend
    if (origDb === undefined) delete process.env.KOKORO_MESSAGE_STORE_DB
    else process.env.KOKORO_MESSAGE_STORE_DB = origDb
  })

  test("memory backend", () => {
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "memory"
    expect(makeMessageStore()).toBeInstanceOf(MemoryMessageStore)
  })

  test("默认 sqlite（未设 backend）", () => {
    delete process.env.KOKORO_MESSAGE_STORE_BACKEND
    process.env.KOKORO_MESSAGE_STORE_DB = ":memory:"
    expect(makeMessageStore()).toBeInstanceOf(SqliteMessageStore)
  })

  test("未知 backend 显式抛错", () => {
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "bogus"
    expect(() => makeMessageStore()).toThrow("bogus")
  })
})
