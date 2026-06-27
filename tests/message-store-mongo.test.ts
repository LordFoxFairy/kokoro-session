import { afterAll, describe, expect, test } from "bun:test"

import { MongoClient } from "mongodb"

import { makeMessageStore, MongoMessageStore } from "../src/infrastructure/message-store"
import { assertBehaviour, stored } from "./message-store-helpers"

// 无 mongo 时整组干净 skip（不 fail）：先探测连接，连不上直接跳过（与 stream-redis.test 同约定）。
const MONGO_URL = process.env.KOKORO_TEST_MONGO_URL ?? "mongodb://127.0.0.1:27117"

async function probeMongo(): Promise<MongoClient | null> {
  try {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 800 })
    await client.connect()
    await client.db("admin").command({ ping: 1 })
    return client
  } catch {
    return null
  }
}

const client = await probeMongo()
const itOrSkip = client ? test : test.skip

afterAll(async () => {
  if (client) await client.close()
})

describe("MongoMessageStore", () => {
  itOrSkip("满足三后端共用的行为矩阵契约", async () => {
    const dbName = `kokoro_test_${Date.now()}`
    const store = new MongoMessageStore(client as MongoClient, dbName)
    try {
      await assertBehaviour(store)
    } finally {
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("落库跨连接持久（另一连接读同库同集合）", async () => {
    const dbName = `kokoro_test_${Date.now()}_persist`
    const writer = new MongoMessageStore(client as MongoClient, dbName)
    const sid = "s"
    await writer.append(sid, [stored(sid, "c1", "x"), stored(sid, "c2", "y")])
    // 全新连接（模拟另一 pod）读同库 → 持久历史不丢。
    const reader = new MongoMessageStore(new MongoClient(MONGO_URL), dbName)
    try {
      expect((await reader.read(sid)).map((s) => s.cursor)).toEqual(["c1", "c2"])
    } finally {
      await reader.close()
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("工厂按 backend=mongo 选 MongoMessageStore", () => {
    const prevBackend = process.env.KOKORO_MESSAGE_STORE_BACKEND
    const prevUrl = process.env.KOKORO_MESSAGE_STORE_MONGO_URL
    process.env.KOKORO_MESSAGE_STORE_BACKEND = "mongo"
    process.env.KOKORO_MESSAGE_STORE_MONGO_URL = MONGO_URL
    try {
      const selected = makeMessageStore()
      expect(selected).toBeInstanceOf(MongoMessageStore)
      void (selected as MongoMessageStore).close()
    } finally {
      if (prevBackend === undefined) delete process.env.KOKORO_MESSAGE_STORE_BACKEND
      else process.env.KOKORO_MESSAGE_STORE_BACKEND = prevBackend
      if (prevUrl === undefined) delete process.env.KOKORO_MESSAGE_STORE_MONGO_URL
      else process.env.KOKORO_MESSAGE_STORE_MONGO_URL = prevUrl
    }
  })
})
