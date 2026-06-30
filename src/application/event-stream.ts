// 应用层拥有的端口契约：接口定义在上层，infrastructure 提供实现（依赖倒置）。

// 跨进程事件流抽象（memory | redis）：消费方最小契约。
// publish 返回单调游标；subscribe(fromCursor) 续订；delete 收束已终态的流。
export type StreamItem = {
  cursor: string
  // event 为未校验的原始载荷，由消费侧（normalize）负责 Zod 解析。
  event: unknown
}

export interface StreamProtocol {
  // maxlen：有界流（如会话 live 总线）发布即按 MAXLEN 近似裁剪，老历史归 SessionStore 持久；
  // 省略则不裁剪（请求流 / per-run 事件流须留全量供 resume 与 relay 重读）。
  publish(stream: string, event: unknown, opts?: { maxlen?: number }): Promise<string>
  subscribe(stream: string, fromCursor?: string): AsyncIterable<StreamItem>
  delete(stream: string): Promise<void>
}
