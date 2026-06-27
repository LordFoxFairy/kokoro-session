import { Database } from "bun:sqlite"

import type { MessageStore } from "../../application/event-stream"
import { parseSessionEvent, type SessionEvent } from "../../domain/session-event"

// bun:sqlite 的 run() 执行单条语句，故建表/建索引分开（多语句一次 run 会失败）。
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS session_message (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  event_id   TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
)`
// 索引 (session_id, seq) 支撑「按会话取、按 seq 序」；同 seq 的稳定序由 read 的 ORDER BY ... rowid
// 兜（rowid 是隐式行键、不可入索引表达式，但 ORDER BY 可用）。
const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_session_message_seq ON session_message(session_id, seq)"

// bun 内置 sqlite（零依赖）：本地落盘的默认持久消息库。
export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: Database) {
    // WAL + busy_timeout：跨进程并发读写互等而非立刻 SQLITE_BUSY 报错；DDL 幂等，重启续用同一文件。
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA busy_timeout=5000")
    db.run(CREATE_TABLE)
    db.run(CREATE_INDEX)
  }

  append(sessionId: string, events: SessionEvent[]): Promise<void> {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO session_message(session_id, seq, event_id, event_json) VALUES(?, ?, ?, ?)",
    )
    // 单事务批量插：少 fsync；INSERT OR IGNORE 按 (session_id, event_id) 幂等去重（重连/重放安全）。
    const tx = this.db.transaction((evs: SessionEvent[]) => {
      for (const e of evs) insert.run(sessionId, e.seq, e.event_id, JSON.stringify(e))
    })
    tx(events)
    return Promise.resolve()
  }

  read(
    sessionId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<SessionEvent[]> {
    const after = opts?.afterSeq ?? -1
    const limit = opts?.limit ?? -1 // sqlite LIMIT -1 = 无上限
    const rows = this.db
      .query(
        "SELECT event_json FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq, rowid LIMIT ?",
      )
      .all(sessionId, after, limit) as { event_json: string }[]
    // 出库即过 Zod：DB 里若有被外部污染的脏行，宁可在此抛错也不把脏数据回放给 web。
    return Promise.resolve(rows.map((r) => parseSessionEvent(JSON.parse(r.event_json) as unknown)))
  }
}
