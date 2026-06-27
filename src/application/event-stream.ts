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

// 会话消息的持久存储（sqlite 默认本地落盘 / mongo 跨 pod / memory 易失）：把长期历史从 redis 卸到
// DB，redis 退为实时总线。append 落库（按 event_id 幂等去重）；read 按 (seq, 到达序) 有序回放，
// afterSeq 支持增量/分页。read 的「哪份数据」由 sessionId 选，与 redis 的 stream key 同一身份维度。
export interface MessageStore {
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string, opts?: { afterSeq?: number; limit?: number }): Promise<SessionEvent[]>
}
