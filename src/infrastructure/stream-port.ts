import { Redis } from "ioredis"

import type { StreamItem, StreamPort } from "../application/ports"

// 这三个常量是 Python/TypeScript 共享的 transport contract，不能随意漂移。
const CURSOR_WIDTH = 20
const REDIS_FIELD = "data"
const DEFAULT_BLOCK_MS = 1000

// 进程内单机用：自增序号当游标，等待者用一组 resolver 唤醒，避免忙等轮询。
export class MemoryStreamPort implements StreamPort {
  private readonly streams = new Map<string, StreamItem[]>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private counter = 0
  private readonly cursorWidth: number

  constructor(options?: { cursorWidth?: number }) {
    this.cursorWidth = options?.cursorWidth ?? CURSOR_WIDTH
  }

  async publish(stream: string, event: unknown): Promise<string> {
    const cursor = String(++this.counter).padStart(this.cursorWidth, "0")
    const items = this.streams.get(stream) ?? []
    items.push({ cursor, event })
    this.streams.set(stream, items)
    this.wake(stream)
    return cursor
  }

  async readAll(stream: string): Promise<StreamItem[]> {
    return [...(this.streams.get(stream) ?? [])]
  }

  async *subscribe(
    stream: string,
    fromCursor?: string,
  ): AsyncIterable<StreamItem> {
    let lastCursor = fromCursor ?? ""
    while (true) {
      const items = this.streams.get(stream) ?? []
      let yielded = false
      for (const item of items) {
        if (item.cursor > lastCursor) {
          lastCursor = item.cursor
          yielded = true
          yield item
        }
      }
      if (!yielded) {
        await this.waitForWake(stream)
      }
    }
  }

  async close(): Promise<void> {
    this.wakeAll()
  }

  private wake(stream: string): void {
    const pending = this.waiters.get(stream)
    if (pending) {
      this.waiters.delete(stream)
      for (const resolve of pending) resolve()
    }
  }

  private wakeAll(): void {
    for (const stream of [...this.waiters.keys()]) this.wake(stream)
  }

  private waitForWake(stream: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const pending = this.waiters.get(stream) ?? []
      pending.push(resolve)
      this.waiters.set(stream, pending)
    })
  }
}

// Redis Streams：xadd 写入（游标=条目 id），xrange 取全量，xread BLOCK 续订。
export class RedisStreamPort implements StreamPort {
  private readonly redis: Redis
  private readonly blockMs: number

  constructor(url: string, options?: { blockMs?: number }) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })
    this.blockMs = options?.blockMs ?? DEFAULT_BLOCK_MS
    // 探测连接失败时 ioredis 会发 error 事件；吞掉以免污染测试输出（调用方靠 ping() 抛错判活）。
    this.redis.on("error", () => {})
  }

  async ping(): Promise<void> {
    await this.redis.connect()
    await this.redis.ping()
  }

  async publish(stream: string, event: unknown): Promise<string> {
    await this.ensureConnected(this.redis)
    const id = await this.redis.xadd(stream, "*", REDIS_FIELD, JSON.stringify(event))
    if (!id) throw new Error("redis xadd returned no id")
    return id
  }

  async readAll(stream: string): Promise<StreamItem[]> {
    await this.ensureConnected(this.redis)
    const entries = await this.redis.xrange(stream, "-", "+")
    return entries.map(([cursor, fields]) => ({
      cursor,
      event: decodeFields(fields),
    }))
  }

  async *subscribe(
    stream: string,
    fromCursor?: string,
  ): AsyncIterable<StreamItem> {
    // 每个订阅独占一条连接：BLOCK xread 会霸占连接，若共享一条，则 dispatch 循环、
    // 各 run 的 relay 与多个 SSE /stream 会互相饿死、最终把端点拖死。用完即断。
    const conn = this.redis.duplicate()
    conn.on("error", () => {})
    try {
      await this.ensureConnected(conn)
      // 空串与缺省都从流首读起；Redis xread 不接受 "" 作为合法 id。
      let lastId = fromCursor || "0-0"
      while (true) {
        const result = await conn.xread("BLOCK", this.blockMs, "STREAMS", stream, lastId)
        if (!result) continue
        for (const [, entries] of result) {
          for (const [cursor, fields] of entries) {
            lastId = cursor
            yield { cursor, event: decodeFields(fields) }
          }
        }
      }
    } finally {
      // 消费方停止迭代（SSE 断开 / dispatch 收束）时归还连接，避免连接泄漏。
      conn.disconnect()
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect()
  }

  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === "ready" || client.status === "connecting") return
    if (client.status === "wait" || client.status === "close" || client.status === "end") {
      await client.connect()
    }
  }
}

function decodeFields(fields: string[]): unknown {
  const idx = fields.indexOf(REDIS_FIELD)
  if (idx < 0 || idx + 1 >= fields.length) return null
  const raw = fields[idx + 1]
  if (raw === undefined) return null
  return JSON.parse(raw) as unknown
}

// 工厂：按 KOKORO_STREAM_BACKEND 选择实现，默认 memory。
export function makeStreamPort(): StreamPort {
  const backend = process.env.KOKORO_STREAM_BACKEND ?? "memory"
  if (backend === "redis") {
    return new RedisStreamPort(
      process.env.KOKORO_REDIS_URL ?? "redis://127.0.0.1:6379",
    )
  }
  return new MemoryStreamPort()
}
