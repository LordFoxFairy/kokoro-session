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
  // maxlen：有界流（如会话 live 总线）发布即按 MAXLEN 近似裁剪，老历史归 MessageStore 持久；
  // 省略则不裁剪（请求流 / per-run 事件流须留全量供 resume 与 relay 重读）。
  publish(stream: string, event: unknown, opts?: { maxlen?: number }): Promise<string>
  subscribe(stream: string, fromCursor?: string): AsyncIterable<StreamItem>
  delete(stream: string): Promise<void>
}

// 一条持久历史条目：领域事件 + 它的 transport cursor（= SSE id 轴，会话级单调、续点锚）。
export type StoredEvent = {
  cursor: string
  event: SessionEvent
}

// 会话消息的持久真源（mongo 跨 pod / memory 仅测试）：长期历史从 redis 卸到 DB，
// redis 退为有界实时总线。append 按 event_id 幂等去重（relay 重启会以新 cursor 重投同一事件，保首条 cursor
// 稳定）；read 按到达序回放，afterCursor 增量续点（未知 cursor 退回全量，web event_id 去重兜底，绝不空流）。
export interface MessageStore {
  append(sessionId: string, events: StoredEvent[]): Promise<void>
  read(sessionId: string, opts?: { afterCursor?: string; limit?: number }): Promise<StoredEvent[]>
  readRun(sessionId: string, runId: string): Promise<StoredEvent[]>
}
