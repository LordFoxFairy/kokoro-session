// mongodb 固定 6.3.0（精确、非 caret）：7.x 的 bson 在静态初始化里调用 node:v8 startupSnapshot
// .isBuildingSnapshot()，Bun 尚未实现 → import 即 ERR_NOT_IMPLEMENTED 崩。升级须先验 `bun -e import("mongodb")`。
import { type Collection, type Filter, MongoClient } from "mongodb"

import type { MessageStore, StoredEvent } from "../../application/event-stream"
import { parseSessionEvent, type SessionEvent } from "../../domain/session-event"

type MessageDoc = {
  session_id: string
  cursor: string
  event_id: string
  event: SessionEvent
}

// 跨 pod 持久消息库：按 cursor-keyed 契约持久化 session 事件。到达序由 ObjectId(_id) 单调兜（ordered 写保插入序），
// (session_id, event_id) 唯一索引作幂等去重锚（relay 重启以新 cursor 重投 → upsert $setOnInsert 保首条）。
export class MongoMessageStore implements MessageStore {
  private readonly coll: Collection<MessageDoc>
  private indexReady: Promise<unknown> | undefined

  constructor(
    private readonly client: MongoClient,
    dbName: string,
    collectionName = "session_message",
  ) {
    this.coll = client.db(dbName).collection<MessageDoc>(collectionName)
  }

  // 惰性建一次唯一索引：append 的 upsert 去重与并发安全都靠它。
  private ensureIndex(): Promise<unknown> {
    this.indexReady ??= this.coll.createIndex({ session_id: 1, event_id: 1 }, { unique: true })
    return this.indexReady
  }

  async append(sessionId: string, events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.ensureIndex()
    await this.coll.bulkWrite(
      events.map((s) => ({
        updateOne: {
          filter: { session_id: sessionId, event_id: s.event.event_id },
          update: {
            $setOnInsert: {
              session_id: sessionId,
              cursor: s.cursor,
              event_id: s.event.event_id,
              event: s.event,
            },
          },
          upsert: true,
        },
      })),
      { ordered: true },
    )
  }

  async read(
    sessionId: string,
    opts?: { afterCursor?: string; limit?: number },
  ): Promise<StoredEvent[]> {
    await this.ensureIndex()
    // afterCursor 命中 → 以其 _id 续读；未命中（裁剪/升级残留）→ 不加过滤，退回全量（不空流）。
    const anchor =
      opts?.afterCursor === undefined
        ? null
        : await this.coll.findOne(
            { session_id: sessionId, cursor: opts.afterCursor },
            { projection: { _id: 1 } },
          )
    const filter: Filter<MessageDoc> = anchor
      ? { session_id: sessionId, _id: { $gt: anchor._id } }
      : { session_id: sessionId }
    const query = this.coll.find(filter).sort({ _id: 1 })
    if (opts?.limit !== undefined) query.limit(opts.limit)
    const docs = await query.toArray()
    // 出库即过 Zod：DB 脏行宁可在此抛错也不回放给 web。
    return docs.map((d) => ({ cursor: d.cursor, event: parseSessionEvent(d.event) }))
  }

  close(): Promise<void> {
    return this.client.close()
  }
}
