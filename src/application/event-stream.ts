import type { SessionEvent } from "../domain/session-event"

// 应用层拥有的端口契约：接口定义在上层，infrastructure 提供实现（依赖倒置）。

// 跨进程事件流抽象（memory | redis）：消费方最小契约。
// publish 返回单调游标；subscribe(fromCursor) 续订；delete 收束已终态的流。
export type StreamItem = {
  cursor: string
  // event 为未校验的原始载荷，由消费侧（normalize）负责 Zod 解析。
  event: unknown
}

export interface StreamProtocol {
  publish(stream: string, event: unknown): Promise<string>
  subscribe(stream: string, fromCursor?: string): AsyncIterable<StreamItem>
  delete(stream: string): Promise<void>
}

// 会话级 AGUI 事件的持久回放，由 StreamProtocol 背书（memory/redis 可换）。
export interface ReplayStore {
  append(sessionId: string, events: SessionEvent[]): Promise<void> | void
}

// 一条持久历史条目：领域事件 + 它的 transport cursor（= SSE id 轴，会话级单调、续点锚）。
export type StoredEvent = {
  cursor: string
  event: SessionEvent
}

// 会话消息的持久真源（sqlite 默认本地落盘 / mongo 跨 pod / memory 易失）：长期历史从 redis 卸到 DB，
// redis 退为有界实时总线。append 按 event_id 幂等去重（relay 重启会以新 cursor 重投同一事件，保首条 cursor
// 稳定）；read 按到达序回放，afterCursor 增量续点（未知 cursor 退回全量，web event_id 去重兜底，绝不空流）。
export interface MessageStore {
  append(sessionId: string, events: StoredEvent[]): Promise<void>
  read(sessionId: string, opts?: { afterCursor?: string; limit?: number }): Promise<StoredEvent[]>
}
