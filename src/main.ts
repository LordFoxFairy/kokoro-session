import { z } from "zod"

import { dispatchRelays } from "./application/dispatch-relays"
import { makeReplayStore } from "./infrastructure/replay-store"
import { makeStream } from "./infrastructure/stream"
import { buildServer } from "./interfaces/http"

const DEFAULT_PORT = 3001

// catch() 把 NaN/越界端口收敛回默认值，避免脏 KOKORO_SESSION_PORT 让 listen 静默失败。
const portSchema = z.coerce.number().int().min(1).max(65535).catch(DEFAULT_PORT)

export function resolvePort(raw: string | undefined): number {
  return portSchema.parse(raw ?? String(DEFAULT_PORT))
}

function main(): void {
  const port = resolvePort(process.env.KOKORO_SESSION_PORT)
  const bus = makeStream()
  const replayStore = makeReplayStore(bus)

  void dispatchRelays(bus, replayStore).catch((error: unknown) => {
    console.error("dispatch loop crashed", error)
  })

  const server = buildServer({ bus, replayStore })
  server.on("error", (error: unknown) => {
    console.error(`kokoro-session failed to bind :${port}`, error)
    process.exit(1)
  })
  server.listen(port, () => {
    console.log(`kokoro-session listening on :${port}`)
  })
}

process.on("unhandledRejection", (reason: unknown) => {
  console.error("unhandledRejection", reason)
  process.exit(1)
})

process.on("uncaughtException", (error: unknown) => {
  console.error("uncaughtException", error)
  process.exit(1)
})

// 仅作为入口直接运行时启动服务；被测试 import 时不应拉起 HTTP 监听。
if (import.meta.main) {
  main()
}
