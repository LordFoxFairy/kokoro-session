import type { SessionEvent } from "../domain/session-event"

// 应用层拥有的端口契约：接口定义在上层，infrastructure 提供实现（依赖倒置）。

// 跨进程事件流抽象（memory | redis）。与 Python 侧契约镜像：
// publish 返回单调游标；subscribe(fromCursor) 续订；readAll 取全量快照。
export type StreamItem = {
  cursor: string
  // event 为未校验的原始载荷，由消费侧（normalize）负责 Zod 解析。
  event: unknown
}

export interface StreamProtocol {
  publish(stream: string, event: unknown): Promise<string>
  readAll(stream: string): Promise<StreamItem[]>
  subscribe(stream: string, fromCursor?: string): AsyncIterable<StreamItem>
  delete(stream: string): Promise<void>
  close(): Promise<void>
}

// 会话级 AGUI 事件的持久回放，由 StreamProtocol 背书（memory/redis 可换）。
export interface ReplayStore {
  append(sessionId: string, events: SessionEvent[]): Promise<void> | void
  read(sessionId: string): SessionEvent[]
}
