import { rmSync } from "node:fs"

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"

import type { MessageStore, StoredEvent } from "../src/application/event-stream"
import type { SessionEvent } from "../src/domain/session-event"
import {
  makeMessageStore,
  MemoryMessageStore,
  SqliteMessageStore,
} from "../src/infrastructure/message-store"

function stored(sessionId: string, cursor: string, eventId: string): StoredEvent {
  // 最简合法 SessionEvent（run.created）+ 其 transport cursor（= SSE id 轴）。
  const event: SessionEvent = {
    event: "run.created",
    event_id: eventId,
    seq: 0,
    session_id: sessionId,
    conversation_id: sessionId,
    run_id: "run_1",
    timestamp: "2026-05-30T00:00:00.000Z",
    payload: { run_id: "run_1" },
  }
  return { cursor, event }
}

// 行为矩阵：按到达序回放、event_id 幂等去重（重投保首条 cursor）、afterCursor 增量、limit、会话隔离。
async function assertBehaviour(store: MessageStore): Promise<void> {
  const sid = "ses_a"
  await store.append(sid, [
    stored(sid, "c1", "e0"),
    stored(sid, "c2", "e1"),
    stored(sid, "c3", "e2"),
  ])
  expect((await store.read(sid)).map((s) => s.cursor)).toEqual(["c1", "c2", "c3"])
  expect((await store.read(sid)).map((s) => s.event.event_id)).toEqual(["e0", "e1", "e2"])

  // event_id 幂等：relay 重启会以新 cursor 重投同一 event_id；只存首次，cursor 保稳定（c2 不被 c9 覆盖）。
  await store.append(sid, [stored(sid, "c9", "e1")])
  const all = await store.read(sid)
  expect(all.length).toBe(3)
  expect(all.map((s) => s.cursor)).toEqual(["c1", "c2", "c3"])

  // afterCursor 增量回放（SSE 从 DB 历史接 redis 实时的桥）。
  expect((await store.read(sid, { afterCursor: "c1" })).map((s) => s.cursor)).toEqual(["c2", "c3"])

  // limit 分页。
  expect((await store.read(sid, { limit: 2 })).map((s) => s.cursor)).toEqual(["c1", "c2"])

  // 会话隔离：read 按 sessionId 只取自己的；未知会话 → []。
  expect(await store.read("ses_other")).toEqual([])

  // 未知 afterCursor（已被裁剪/升级残留）→ 退回全量，web 端 event_id 去重兜底，绝不空流。
  expect((await store.read(sid, { afterCursor: "nope" })).map((s) => s.cursor)).toEqual([
    "c1",
    "c2",
    "c3",
  ])
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
    await writer.append("s", [stored("s", "c1", "x"), stored("s", "c2", "y")])
    // 全新句柄（模拟重启 / 另一进程）读同一文件。
    const reader = new SqliteMessageStore(new Database(path))
    expect((await reader.read("s")).map((s) => s.cursor)).toEqual(["c1", "c2"])
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
