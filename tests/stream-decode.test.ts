import { describe, expect, test } from "bun:test"

import { decodeFields, REDIS_FIELD } from "../src/infrastructure/stream"

// Redis 条目可能因写入方崩溃/裁剪/版本漂移而残留畸形 JSON；
// 守卫需让单条损坏跳过（返回 null）而非炸掉 subscribe/SSE 循环。
describe("decodeFields corruption guard", () => {
  test("decodes a well-formed JSON payload", () => {
    expect(decodeFields([REDIS_FIELD, '{"n":1}'])).toEqual({ n: 1 })
  })

  test("returns null for malformed JSON instead of throwing", () => {
    expect(() => decodeFields([REDIS_FIELD, "{not json"])).not.toThrow()
    expect(decodeFields([REDIS_FIELD, "{not json"])).toBeNull()
  })

  test("returns null when the data field is absent", () => {
    expect(decodeFields(["other", "x"])).toBeNull()
  })

  test("returns null when the data field has no value", () => {
    expect(decodeFields([REDIS_FIELD])).toBeNull()
  })

  test("does not throw on a truncated multibyte payload", () => {
    expect(() => decodeFields([REDIS_FIELD, '{"n":1'])).not.toThrow()
    expect(decodeFields([REDIS_FIELD, '{"n":1'])).toBeNull()
  })
})
