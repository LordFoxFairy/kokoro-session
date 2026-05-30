import { afterAll, describe, expect, test } from "bun:test"

import { RedisStreamPort } from "../src/infrastructure/stream-port"

// 无 redis 时整组干净 skip（不 fail）：先探测连接，连不上直接跳过。
const REDIS_URL = process.env.KOKORO_REDIS_URL ?? "redis://127.0.0.1:6379"

async function probeRedis(): Promise<RedisStreamPort | null> {
  try {
    const port = new RedisStreamPort(REDIS_URL)
    await port.ping()
    return port
  } catch {
    return null
  }
}

const port = await probeRedis()
const itOrSkip = port ? test : test.skip

let live: RedisStreamPort

afterAll(async () => {
  if (port) await port.close()
})

describe("RedisStreamPort", () => {
  itOrSkip("publish/readAll round-trips with monotonic distinct cursors", async () => {
    live = port as RedisStreamPort
    const stream = `kokoro:test:${Date.now()}`
    const c1 = await live.publish(stream, { n: 1 })
    const c2 = await live.publish(stream, { n: 2 })
    expect(c1).not.toBe(c2)

    const all = await live.readAll(stream)
    expect(all.map((e) => e.event)).toEqual([{ n: 1 }, { n: 2 }])
  })

  itOrSkip("subscribe(fromCursor) resumes after the given cursor", async () => {
    live = port as RedisStreamPort
    const stream = `kokoro:test:${Date.now()}:b`
    const c1 = await live.publish(stream, { n: 1 })
    await live.publish(stream, { n: 2 })

    const seen: unknown[] = []
    for await (const item of live.subscribe(stream, c1)) {
      seen.push(item.event)
      break
    }
    expect(seen).toEqual([{ n: 2 }])
  })
})
