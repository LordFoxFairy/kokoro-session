import { MongoClient } from "mongodb"

import type { MessageStore } from "../../application/event-stream"
import { MemoryMessageStore } from "./memory"
import { MongoMessageStore } from "./mongo"

// 按 KOKORO_MESSAGE_STORE_BACKEND 选消息库：mongo（默认，跨 pod 持久真源）/
// memory（易失，仅测试用）。SQLite 已从 session runtime 移除，避免产生第二套本地事实源。
export function makeMessageStore(): MessageStore {
  const backend = (process.env.KOKORO_MESSAGE_STORE_BACKEND ?? "mongo").toLowerCase()
  if (backend === "memory") return new MemoryMessageStore()
  if (backend === "mongo") {
    const url = process.env.KOKORO_MESSAGE_STORE_MONGO_URL ?? "mongodb://127.0.0.1:27017"
    const dbName = process.env.KOKORO_MESSAGE_STORE_MONGO_DB ?? "kokoro"
    return new MongoMessageStore(new MongoClient(url), dbName)
  }
  throw new Error(`unknown KOKORO_MESSAGE_STORE_BACKEND: ${backend}`)
}
