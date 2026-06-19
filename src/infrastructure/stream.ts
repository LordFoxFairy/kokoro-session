import { Redis } from "ioredis"

import type { StreamItem, StreamProtocol } from "../application/event-stream"

// 这三个常量是 Python/TypeScript 共享的 transport contract，不能随意漂移。
const CURSOR_WIDTH = 20
export const REDIS_FIELD = "data"
const DEFAULT_BLOCK_MS = 1000

// 首个 cursor > fromCursor 的下标；items 按定宽游标升序，二分定位续点。
function indexAfter(items: StreamItem[], fromCursor: string): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (items[mid]!.cursor > fromCursor) hi = mid
    else lo = mid + 1
  }
  return lo
}

// 进程内单机用：自增序号当游标，等待者用一组 resolver 唤醒，避免忙等轮询。
export class MemoryStream implements StreamProtocol {
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
    // 流仅追加、游标定宽零填充单调递增：维护 lastIndex 偏移续读，避免每次唤醒全扫（O(n²)）。
    // 每次重取数组引用：首次 publish 与 delete 后会换新数组（见 publish/delete）。
    let lastIndex = 0
    let initialized = fromCursor === undefined
    while (true) {
      const items = this.streams.get(stream) ?? []
      if (!initialized) {
        // 续点：定位首个 cursor > fromCursor 的下标（升序二分），之后纯按偏移推进。
        lastIndex = indexAfter(items, fromCursor!)
        initialized = true
      } else if (lastIndex > items.length) {
        // delete 后换了更短的新数组：偏移失效，从首读起（counter 不复用，新游标必然更大）。
        lastIndex = 0
      }
      if (lastIndex < items.length) {
        yield items[lastIndex]!
        lastIndex += 1
        continue
      }
      await this.waitForWake(stream)
    }
  }

  async close(): Promise<void> {
    this.wakeAll()
  }

  async delete(stream: string): Promise<void> {
    this.streams.delete(stream)
    this.wake(stream)
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
export class RedisStream implements StreamProtocol {
  private readonly redis: Redis
  private readonly blockMs: number

  constructor(url: string, options?: { blockMs?: number }) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })
    this.blockMs = options?.blockMs ?? DEFAULT_BLOCK_MS
    // 探测连接失败时 ioredis 会发 error 事件；忽略以免干扰测试输出（调用方靠 ping() 抛错判活）。
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
    // 每个订阅独占一条连接、用完即断：BLOCK xread 独占连接，共享会导致各消费者互相阻塞。
    const conn = this.redis.duplicate()
    conn.on("error", () => {})
    try {
      await this.ensureConnected(conn)
      // 退化到 "0-0" 从流首读起（xread 不接受 "" 作 id）；
      // 续点假设条目未被裁剪，将来加 XTRIM 须检测裁剪并回退全量。
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

  async delete(stream: string): Promise<void> {
    await this.ensureConnected(this.redis)
    await this.redis.del(stream)
  }

  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === "ready" || client.status === "connecting") return
    if (client.status === "wait" || client.status === "close" || client.status === "end") {
      await client.connect()
    }
  }
}

export function decodeFields(fields: string[]): unknown {
  const idx = fields.indexOf(REDIS_FIELD)
  if (idx < 0 || idx + 1 >= fields.length) return null
  const raw = fields[idx + 1]
  if (raw === undefined) return null
  // 损坏条目（崩溃/裁剪残留）跳过为 null，避免单条畸形 JSON 炸掉 subscribe/SSE 循环。
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

// 工厂：按 KOKORO_STREAM_BACKEND 选择实现，默认 memory。
export function makeStream(): StreamProtocol {
  const backend = process.env.KOKORO_STREAM_BACKEND ?? "memory"
  if (backend === "redis") {
    return new RedisStream(
      process.env.KOKORO_REDIS_URL ?? "redis://127.0.0.1:6379",
    )
  }
  return new MemoryStream()
}
