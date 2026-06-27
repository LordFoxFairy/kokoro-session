// 真 e2e 客户端（被 redis-sqlite-e2e.sh 拉起）：redis live 总线 + sqlite 历史，打真 server 的 HTTP/SSE。
// 验证三件事——(1) 经真 redis 总线的 SSE 实时链路通；(2) 历史确落 sqlite；
// (3) 删掉 redis live 流后，全新 SSE 仍能从 sqlite 全量重放历史（= redis 减负的决定性证明）。
import { Database } from "bun:sqlite"

import { REQUESTS_STREAM, runEventsStream } from "../src/application/stream-names"
import { liveStream } from "../src/infrastructure/live-bus"
import { RedisStream } from "../src/infrastructure/stream"

const SESS_URL = process.env.E2E_SESS_URL!
const REDIS_URL = process.env.E2E_REDIS_URL!
const DB_PATH = process.env.E2E_DB!
const SID = `ses_e2e_${Date.now()}`

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// 读 SSE 直到出现 run.completed 或超时，返回已读文本。
async function readSse(lastEventId?: string): Promise<string> {
  const res = await fetch(`${SESS_URL}/sessions/${SID}/stream`, {
    headers: {
      accept: "text/event-stream",
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    signal: AbortSignal.timeout(4000),
  })
  const reader = res.body?.getReader()
  if (!reader) return fail("no SSE body")
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.includes("event: run.completed")) {
        await reader.cancel()
        break
      }
    }
  } catch {
    // 超时即返回已读部分，交断言判定。
  }
  return buf
}

function assertHas(text: string, events: string[], label: string): void {
  for (const ev of events) {
    if (!text.includes(`event: ${ev}`)) fail(`${label} missing ${ev}\n---\n${text}`)
  }
}

const redis = new RedisStream(REDIS_URL)
await redis.ping()

// 1) 经真 HTTP 起 run（server 发 run.request 到 redis 请求流，dispatchRelays 起 relay）。
const startRes = await fetch(`${SESS_URL}/sessions/${SID}/runs?input=hello`, { method: "POST" })
if (startRes.status !== 200) fail(`start run status ${startRes.status}`)
const { runId } = (await startRes.json()) as { runId: string }
console.log(`run started: ${runId} (session ${SID})`)

const reqs = await redis.readAll(REQUESTS_STREAM)
if (!reqs.some((r) => (r.event as { run_id?: string }).run_id === runId)) {
  fail("run.request not found on redis requests stream")
}

// 2) 模拟 agent worker：把 canonical wire 事件写入 redis run 事件流。relay 归一化 → live + sqlite。
const env = { request_id: runId, timestamp: 1700000000 }
const evStream = runEventsStream(runId)
await redis.publish(evStream, { event: "agent_status", ...env, data: { status: "started" } })
await redis.publish(evStream, {
  event: "text_chunk",
  ...env,
  data: { segment_id: "m1", text: "Hi", final: false },
})
await redis.publish(evStream, {
  event: "text_chunk",
  ...env,
  data: { segment_id: "m1", text: "Hi there", final: true },
})
await redis.publish(evStream, { event: "agent_done", ...env, data: { status: "completed", usage: {} } })

// 3) 第一条 SSE：实时链路（redis live 总线 → server tail）。
assertHas(await readSse(), ["session.created", "run.created", "message.delta", "message.completed", "run.completed"], "SSE#1")
console.log("SSE#1 OK: live path through real redis delivered all events")

// 4) 历史确落 sqlite（只读句柄并发读 WAL）。
const db = new Database(DB_PATH, { readonly: true })
const rows = db
  .query("SELECT event_json FROM session_message WHERE session_id = ? ORDER BY rowid")
  .all(SID) as { event_json: string }[]
const persisted = rows.map((r) => (JSON.parse(r.event_json) as { event: string }).event)
db.close()
if (rows.length === 0) fail("sqlite has no rows for session")
for (const ev of ["session.created", "run.created", "message.completed", "run.completed"]) {
  if (!persisted.includes(ev)) fail(`sqlite missing ${ev}; got ${persisted.join(",")}`)
}
console.log(`sqlite OK: ${rows.length} rows persisted [${persisted.join(", ")}]`)

// 5) 决定性证明：删掉 redis live 流（模拟 MAXLEN 裁剪/驱逐），全新 SSE 仍须从 sqlite 全量重放历史。
await redis.delete(liveStream(SID))
const remaining = await redis.readAll(liveStream(SID))
if (remaining.length !== 0) fail(`redis live stream not empty after delete (${remaining.length})`)
console.log(`redis live stream ${liveStream(SID)} deleted — history must now come from sqlite`)

assertHas(await readSse(), ["session.created", "run.created", "message.completed", "run.completed"], "SSE#2 (post-trim)")
console.log("SSE#2 OK: full history replayed from sqlite AFTER redis live trimmed ✅ (redis relief proven)")

await redis.close()
console.log("E2E PASS")
process.exit(0)
