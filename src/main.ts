import { dispatchRelays } from "./application/dispatch-relays"
import { makeReplayStore } from "./infrastructure/replay-store"
import { makeStreamPort } from "./infrastructure/stream-port"
import { buildServer } from "./interfaces/http"

const PORT = Number(process.env.KOKORO_SESSION_PORT ?? 3001)

function main(): void {
  const streamPort = makeStreamPort()
  const replayStore = makeReplayStore(streamPort)

  void dispatchRelays(streamPort, replayStore).catch((error: unknown) => {
    console.error("dispatch loop crashed", error)
  })

  const server = buildServer({ streamPort, replayStore })
  server.listen(PORT, () => {
    console.log(`kokoro-session listening on :${PORT}`)
  })
}

main()
