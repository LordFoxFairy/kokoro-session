import { Database } from "bun:sqlite"

import type { MessageStore } from "../../application/event-stream"
import { MemoryMessageStore } from "./memory"
import { SqliteMessageStore } from "./sqlite"

// 按 KOKORO_MESSAGE_STORE_BACKEND 选持久消息库：sqlite（默认，本地落盘，零依赖）/ memory（易失，
// 测试用）。mongo（跨 pod）见 P2。落盘路径由 KOKORO_MESSAGE_STORE_DB 配置。
export function makeMessageStore(): MessageStore {
  const backend = (process.env.KOKORO_MESSAGE_STORE_BACKEND ?? "sqlite").toLowerCase()
  if (backend === "memory") return new MemoryMessageStore()
  if (backend === "sqlite") {
    const path = process.env.KOKORO_MESSAGE_STORE_DB ?? "kokoro-session-messages.db"
    return new SqliteMessageStore(new Database(path))
  }
  throw new Error(`unknown KOKORO_MESSAGE_STORE_BACKEND: ${backend}`)
}
