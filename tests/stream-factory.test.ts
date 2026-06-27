import { afterEach, describe, expect, test } from "bun:test"

import { MemoryStream, RedisStream, makeStream } from "../src/infrastructure/stream"

describe("makeStream factory", () => {
  const original = process.env.KOKORO_STREAM_BACKEND

  afterEach(() => {
    if (original === undefined) delete process.env.KOKORO_STREAM_BACKEND
    else process.env.KOKORO_STREAM_BACKEND = original
  })

  test("defaults to MemoryStream", () => {
    delete process.env.KOKORO_STREAM_BACKEND
    expect(makeStream()).toBeInstanceOf(MemoryStream)
  })

  test("selects RedisStream lazily when backend=redis", () => {
    // lazyConnect → 构造不即连，故无 live redis 也能断言类型。
    process.env.KOKORO_STREAM_BACKEND = "redis"
    process.env.KOKORO_REDIS_URL = "redis://127.0.0.1:6379"
    expect(makeStream()).toBeInstanceOf(RedisStream)
  })
})

describe("MemoryStream.close", () => {
  test("wakes pending subscribers without breaking subsequent delivery", async () => {
    const stream = new MemoryStream()
    const it = stream.subscribe("x")[Symbol.asyncIterator]()
    const pending = it.next() // 无条目 → 阻塞在 waitForWake，注册一个 waiter
    await new Promise((resolve) => setTimeout(resolve, 10))
    await stream.close() // wakeAll 唤醒该 waiter（订阅者重入等待）
    await stream.publish("x", { hello: 1 }) // 随后 publish → 取得，证明 close 没破坏订阅
    const { value } = await pending
    expect(value?.event).toEqual({ hello: 1 })
  })
})

describe("RedisStream.close", () => {
  test("disconnects a lazy client without requiring a live server", async () => {
    const stream = new RedisStream("redis://127.0.0.1:6390")
    // 未连接即 close：disconnect 幂等、不抛、不需 live redis（覆盖 close 分支）。
    await expect(stream.close()).resolves.toBeUndefined()
  })
})
