import { dispatchRelays } from "./application/dispatch-relays"
import { makeReplayStore } from "./infrastructure/replay-store"
import { makeStream } from "./infrastructure/stream"
import { buildServer } from "./interfaces/http"

const PORT = Number(process.env.KOKORO_SESSION_PORT ?? 3001)

function main(): void {
  const bus = makeStream()
  const replayStore = makeReplayStore(bus)

  void dispatchRelays(bus, replayStore).catch((error: unknown) => {
    console.error("dispatch loop crashed", error)
  })

  const server = buildServer({ bus, replayStore })
  server.listen(PORT, () => {
    console.log(`kokoro-session listening on :${PORT}`)
  })
}

main()
