import { describe, expect, test } from "vitest"

import { isDirectEntry, resolvePort } from "../src/main"

describe("resolvePort", () => {
  test("valid in-range port string parses to that number", () => {
    expect(resolvePort("8080")).toBe(8080)
  })

  test("undefined (env unset) falls back to 3001", () => {
    expect(resolvePort(undefined)).toBe(3001)
  })

  test("non-numeric value falls back to 3001 instead of a NaN port", () => {
    expect(resolvePort("abc")).toBe(3001)
  })

  test("out-of-range high port (>65535) falls back to 3001", () => {
    expect(resolvePort("99999")).toBe(3001)
  })

  test("zero is below the min and falls back to 3001", () => {
    expect(resolvePort("0")).toBe(3001)
  })

  test("negative value falls back to 3001", () => {
    expect(resolvePort("-1")).toBe(3001)
  })

  test("fractional value is rejected (int constraint) and falls back", () => {
    expect(resolvePort("3001.5")).toBe(3001)
  })

  test("empty string falls back to 3001", () => {
    expect(resolvePort("")).toBe(3001)
  })
})

describe("isDirectEntry", () => {
  test("matches when argv points at the same module file", () => {
    const entryUrl = new URL("../src/main.ts", import.meta.url)

    expect(isDirectEntry(entryUrl.href, new URL(entryUrl).pathname)).toBe(true)
  })

  test("does not match when the module was imported by another entry", () => {
    const entryUrl = new URL("../src/main.ts", import.meta.url)
    const otherEntry = new URL("./test-runner.ts", import.meta.url)

    expect(isDirectEntry(entryUrl.href, otherEntry.pathname)).toBe(false)
  })

  test("does not match when argv path is absent", () => {
    const entryUrl = new URL("../src/main.ts", import.meta.url)

    expect(isDirectEntry(entryUrl.href, undefined)).toBe(false)
  })
})
