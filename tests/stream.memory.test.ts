import { describe, expect, test } from "bun:test"

import { MemoryStream } from "../src/infrastructure/stream"

const STREAM = "kokoro:test:stream"

describe("MemoryStream", () => {
  test("publish then readAll preserves order with distinct cursors", async () => {
    const port = new MemoryStream()
    const c1 = await port.publish(STREAM, { n: 1 })
    const c2 = await port.publish(STREAM, { n: 2 })
    const c3 = await port.publish(STREAM, { n: 3 })

    expect(new Set([c1, c2, c3]).size).toBe(3)

    const all = await port.readAll(STREAM)
    expect(all.map((e) => e.event)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(all.map((e) => e.cursor)).toEqual([c1, c2, c3])
  })

  test("readAll on an empty stream returns []", async () => {
    const port = new MemoryStream()
    expect(await port.readAll("kokoro:test:empty")).toEqual([])
  })

  test("subscribe(fromCursor) skips events at or before the cursor", async () => {
    const port = new MemoryStream()
    const c1 = await port.publish(STREAM, { n: 1 })
    await port.publish(STREAM, { n: 2 })
    await port.publish(STREAM, { n: 3 })

    const seen: unknown[] = []
    for await (const item of port.subscribe(STREAM, c1)) {
      seen.push(item.event)
      if (seen.length === 2) break
    }
    expect(seen).toEqual([{ n: 2 }, { n: 3 }])
  })

  test("subscribe without fromCursor yields everything from the start", async () => {
    const port = new MemoryStream()
    await port.publish(STREAM, { n: 1 })
    await port.publish(STREAM, { n: 2 })

    const seen: unknown[] = []
    for await (const item of port.subscribe(STREAM)) {
      seen.push(item.event)
      if (seen.length === 2) break
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  test("subscribe delivers events published after subscription starts", async () => {
    const port = new MemoryStream()
    const seen: unknown[] = []

    const consumer = (async () => {
      for await (const item of port.subscribe(STREAM)) {
        seen.push(item.event)
        if (seen.length === 2) break
      }
    })()

    await port.publish(STREAM, { n: 1 })
    await port.publish(STREAM, { n: 2 })
    await consumer
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  test("streams are isolated from each other", async () => {
    const port = new MemoryStream()
    await port.publish("a", { x: 1 })
    await port.publish("b", { y: 2 })
    expect((await port.readAll("a")).map((e) => e.event)).toEqual([{ x: 1 }])
    expect((await port.readAll("b")).map((e) => e.event)).toEqual([{ y: 2 }])
  })

  test("allows a custom cursor width", async () => {
    const port = new MemoryStream({ cursorWidth: 6 })
    const cursor = await port.publish(STREAM, { n: 1 })
    expect(cursor).toBe("000001")
  })
})
