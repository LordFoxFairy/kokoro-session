import { Database } from "bun:sqlite"
import { MongoClient } from "mongodb"

import type { MessageStore } from "../../application/event-stream"
import { MemoryMessageStore } from "./memory"
import { MongoMessageStore } from "./mongo"
import { SqliteMessageStore } from "./sqlite"

// 按 KOKORO_MESSAGE_STORE_BACKEND 选持久消息库：sqlite（默认，本地落盘，零依赖）/ mongo（跨 pod）/
// memory（易失，测试用）。落盘路径 / 连接经各自 env 配置。
export function makeMessageStore(): MessageStore {
  const backend = (process.env.KOKORO_MESSAGE_STORE_BACKEND ?? "sqlite").toLowerCase()
  if (backend === "memory") return new MemoryMessageStore()
  if (backend === "sqlite") {
    const path = process.env.KOKORO_MESSAGE_STORE_DB ?? "kokoro-session-messages.db"
    return new SqliteMessageStore(new Database(path))
  }
  if (backend === "mongo") {
    const url = process.env.KOKORO_MESSAGE_STORE_MONGO_URL ?? "mongodb://127.0.0.1:27017"
    const dbName = process.env.KOKORO_MESSAGE_STORE_MONGO_DB ?? "kokoro"
    return new MongoMessageStore(new MongoClient(url), dbName)
  }
  throw new Error(`unknown KOKORO_MESSAGE_STORE_BACKEND: ${backend}`)
}
