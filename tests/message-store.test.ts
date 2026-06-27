import { rmSync } from "node:fs"

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"

import {
  makeMessageStore,
  MemoryMessageStore,
  SqliteMessageStore,
} from "../src/infrastructure/message-store"
import { assertBehaviour, assertConcurrentIdempotent, stored } from "./message-store-helpers"

describe("MessageStore 行为矩阵", () => {
  test("memory", async () => {
    await assertBehaviour(new MemoryMessageStore())
  })

  test("sqlite", async () => {
    await assertBehaviour(new SqliteMessageStore(new Database(":memory:")))
  })
})

describe("MessageStore 并发幂等", () => {
  test("memory", async () => {
    await assertConcurrentIdempotent(new MemoryMessageStore())
  })

  test("sqlite", async () => {
    await assertConcurrentIdempotent(new SqliteMessageStore(new Database(":memory:")))
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
