import { Database } from "bun:sqlite"

import type { MessageStore, StoredEvent } from "../../application/event-stream"
import { parseSessionEvent } from "../../domain/session-event"

// bun:sqlite 的 run() 执行单条语句，故建表/建索引分开（多语句一次 run 会失败）。
// PK (session_id, event_id)：event_id 幂等去重（relay 重启以新 cursor 重投同一事件，INSERT OR IGNORE 保首条）。
// 到达序由隐式 rowid 兜（自增、单调），故无需显式 seq 列；read 一律 ORDER BY rowid。
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS session_message (
  session_id TEXT NOT NULL,
  cursor     TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
)`
const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_session_message_cursor ON session_message(session_id, cursor)"

// bun 内置 sqlite（零依赖）：本地落盘的默认持久消息库。
export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: Database) {
    // WAL + busy_timeout：跨进程并发读写互等而非立刻 SQLITE_BUSY 报错；DDL 幂等，重启续用同一文件。
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA busy_timeout=5000")
    db.run(CREATE_TABLE)
    db.run(CREATE_INDEX)
  }

  append(sessionId: string, events: StoredEvent[]): Promise<void> {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO session_message(session_id, cursor, event_id, event_json) VALUES(?, ?, ?, ?)",
    )
    // 单事务批量插：少 fsync；INSERT OR IGNORE 按 (session_id, event_id) 幂等去重（重连/重放安全）。
    const tx = this.db.transaction((evs: StoredEvent[]) => {
      for (const s of evs) {
        insert.run(sessionId, s.cursor, s.event.event_id, JSON.stringify(s.event))
      }
    })
    tx(events)
    return Promise.resolve()
  }

  read(
    sessionId: string,
    opts?: { afterCursor?: string; limit?: number },
  ): Promise<StoredEvent[]> {
    const limit = opts?.limit ?? -1 // sqlite LIMIT -1 = 无上限
    // afterCursor 命中 → 取其 rowid 续读；未传 / 未命中（裁剪/升级残留）→ 全量（不空流，web event_id 去重兜底）。
    // 与 MongoMessageStore.read 同形（anchor 有无两分支），不用 COALESCE/空串哨兵那类绕的写法。
    const anchor =
      opts?.afterCursor === undefined
        ? null
        : (this.db
            .query("SELECT rowid FROM session_message WHERE session_id = ? AND cursor = ?")
            .get(sessionId, opts.afterCursor) as { rowid: number } | null)
    const rows = (
      anchor
        ? this.db
            .query(
              "SELECT cursor, event_json FROM session_message WHERE session_id = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3",
            )
            .all(sessionId, anchor.rowid, limit)
        : this.db
            .query(
              "SELECT cursor, event_json FROM session_message WHERE session_id = ?1 ORDER BY rowid LIMIT ?2",
            )
            .all(sessionId, limit)
    ) as { cursor: string; event_json: string }[]
    // 出库即过 Zod：DB 里若有被外部污染的脏行，宁可在此抛错也不把脏数据回放给 web。
    return Promise.resolve(
      rows.map((r) => ({
        cursor: r.cursor,
        event: parseSessionEvent(JSON.parse(r.event_json) as unknown),
      })),
    )
  }
}
