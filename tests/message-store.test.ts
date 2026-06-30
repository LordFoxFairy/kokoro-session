import { afterEach, describe, expect, test } from "bun:test"

import {
  makeMessageStore,
  MemoryMessageStore,
  MongoMessageStore,
} from "../src/infrastructure/message-store"
import { assertBehaviour, assertConcurrentIdempotent } from "./message-store-helpers"

describe("MessageStore 行为矩阵", () => {
  test("memory", async () => {
    await assertBehaviour(new MemoryMessageStore())
  })
})

describe("MessageStore 并发幂等", () => {
  test("memory", async () => {
    await assertConcurrentIdempotent(new MemoryMessageStore())
  })
})

describe("makeMessageStore 工厂", () => {
  const origBackend = process.env.KOKORO_MESSAGE_STORE_BACKEND
  const origUrl = process.env.KOKORO_MESSAGE_STORE_MONGO_URL

  afterEach(() => {
    if (origBackend === undefined) delete process.env.KOKORO_MESSAGE_STORE_BACKEND
    else process.env.KOKORO_MESSAGE_STORE_BACKEND = origBackend
    if (origUrl === undefined) delete process.env.KOKORO_MESSAGE_STORE_MONGO_URL
    else process.env.KOKORO_MESSAGE_STORE_MONGO_URL = origUrl
  })

  test("memory backend", () => {
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "memory"
    expect(makeMessageStore()).toBeInstanceOf(MemoryMessageStore)
  })

  test("默认 mongo（未设 backend）", () => {
    delete process.env.KOKORO_MESSAGE_STORE_BACKEND
    process.env.KOKORO_MESSAGE_STORE_MONGO_URL = "mongodb://127.0.0.1:27017"
    expect(makeMessageStore()).toBeInstanceOf(MongoMessageStore)
  })

  test("sqlite backend 已移除", () => {
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "sqlite"
    expect(() => makeMessageStore()).toThrow("sqlite")
  })

  test("未知 backend 显式抛错", () => {
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "bogus"
    expect(() => makeMessageStore()).toThrow("bogus")
  })
})
