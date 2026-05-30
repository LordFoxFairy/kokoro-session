import type { SessionEvent } from "../domain/events"
import { a2uiOpSchema, type A2uiOp } from "../domain/a2ui"

const CATALOG_ID = "kokoro/chat/v1"

// 把有序的归一化 SessionEvent 投影成 A2UI v0_9 op 流。
// 有状态（root.children 累加、按 message_id 累计文本、surface 单次创建），但状态完全由
// 有序事件流重建——每个 SSE 连接 new 一个，顺序喂 snapshot+tail 即可确定性重放。
export class A2uiProjector {
  private readonly surfaceId: string
  private surfaceCreated = false
  private readonly children: string[] = []
  private thinkingCounter = 0
  private readonly messageText = new Map<string, string>()

  constructor(surfaceId: string) {
    this.surfaceId = surfaceId
  }

  project(event: SessionEvent): A2uiOp[] {
    return this.map(event).map((op) => a2uiOpSchema.parse(op))
  }

  private rootOp(): A2uiOp {
    return {
      version: "v0.9",
      updateComponents: {
        surfaceId: this.surfaceId,
        components: [{ id: "root", component: "Thread", children: [...this.children] }],
      },
    }
  }

  private mountComponent(component: Record<string, unknown>): A2uiOp {
    return { version: "v0.9", updateComponents: { surfaceId: this.surfaceId, components: [component] } }
  }

  private setData(path: string, value: unknown): A2uiOp {
    return { version: "v0.9", updateDataModel: { surfaceId: this.surfaceId, path, value } }
  }

  private map(event: SessionEvent): A2uiOp[] {
    switch (event.event) {
      case "session.created":
        return []
      case "run.created": {
        if (this.surfaceCreated) return []
        this.surfaceCreated = true
        return [
          { version: "v0.9", createSurface: { surfaceId: this.surfaceId, catalogId: CATALOG_ID } },
          this.rootOp(),
        ]
      }
      case "thinking.summary": {
        const id = `th_${++this.thinkingCounter}`
        const path = `/thinking/${id}`
        this.children.push(id)
        return [
          this.mountComponent({ id, component: "ThinkingBlock", summary: { path } }),
          this.setData(path, String(event.payload.summary ?? "")),
          this.rootOp(),
        ]
      }
      case "tool.started": {
        const id = String(event.payload.tool_call_id)
        this.children.push(id)
        return [
          this.mountComponent({ id, component: "ToolCard", toolName: String(event.payload.tool_name), status: "running" }),
          this.rootOp(),
        ]
      }
      case "tool.completed": {
        const id = String(event.payload.tool_call_id)
        return [
          this.mountComponent({ id, component: "ToolCard", toolName: String(event.payload.tool_name), status: String(event.payload.status) }),
        ]
      }
      case "message.delta": {
        const id = String(event.payload.message_id)
        const path = `/messages/${id}`
        const prev = this.messageText.get(id)
        const next = (prev ?? "") + String(event.payload.delta ?? "")
        this.messageText.set(id, next)
        if (prev === undefined) {
          this.children.push(id)
          return [
            this.mountComponent({ id, component: "Message", author: "ai", text: { path } }),
            this.setData(path, next),
            this.rootOp(),
          ]
        }
        return [this.setData(path, next)]
      }
      case "message.completed": {
        const id = String(event.payload.message_id)
        const path = `/messages/${id}`
        this.messageText.set(id, String(event.payload.content ?? ""))
        return [this.setData(path, String(event.payload.content ?? ""))]
      }
      case "run.completed":
        return []
      case "run.failed": {
        const id = `err_${event.run_id}`
        const path = `/messages/${id}`
        this.children.push(id)
        return [
          this.mountComponent({ id, component: "Message", author: "ai", text: { path } }),
          this.setData(path, `⚠️ ${String(event.payload.message ?? "")}`),
          this.rootOp(),
        ]
      }
      default:
        return []
    }
  }
}
