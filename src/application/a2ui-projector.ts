import type { SessionEvent } from "../domain/events"
import { a2uiOpSchema, type A2uiOp, type A2uiComponent } from "../domain/a2ui"

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
  private readonly erroredRuns = new Set<string>()
  // 假设：每个 run 至多一个 plan，id 稳定为 `{run_id}:plan`（见 normalize 的 plan.updated）。
  // 若未来新增第二种 plan 类型，这个单 boolean 会静默抑制其挂载——届时需改为按 id 分轨。
  private planMounted = false
  private readonly mountedPermissionRequestIds = new Set<string>()

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

  private mountComponent(id: string, component: string, extra: Record<string, unknown>): A2uiOp {
    const comp = { id, component, ...extra } as A2uiComponent
    return { version: "v0.9", updateComponents: { surfaceId: this.surfaceId, components: [comp] } }
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
          this.mountComponent(id, "ThinkingBlock", { summary: { path } }),
          this.setData(path, String(event.payload.summary ?? "")),
          this.rootOp(),
        ]
      }
      case "tool.started": {
        const id = String(event.payload.tool_call_id)
        this.children.push(id)
        return [
          this.mountComponent(id, "ToolCard", { toolName: String(event.payload.tool_name), status: "running" }),
          this.rootOp(),
        ]
      }
      case "tool.completed": {
        const id = String(event.payload.tool_call_id)
        return [
          this.mountComponent(id, "ToolCard", { toolName: String(event.payload.tool_name), status: String(event.payload.status) }),
        ]
      }
      case "message.delta": {
        const id = String(event.payload.message_id)
        const path = `/messages/${id}`
        const author = String(event.payload.role ?? "ai") === "user" ? "user" : "ai"
        const prev = this.messageText.get(id)
        const next = (prev ?? "") + String(event.payload.delta ?? "")
        this.messageText.set(id, next)
        if (prev === undefined) {
          this.children.push(id)
          return [
            this.mountComponent(id, "Message", { author, text: { path } }),
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
      case "plan.updated": {
        const id = String(event.payload.plan_id)
        const path = `/plans/${id}`
        const todos = event.payload.todos
        if (!Array.isArray(todos) || todos.length === 0) {
          if (!this.planMounted) return [] // 空且未挂 → 不产
        }
        if (!this.planMounted) {
          this.planMounted = true
          this.children.push(id)
          return [
            this.mountComponent(id, "Plan", { todosPath: { path } }),
            this.setData(path, todos),
            this.rootOp(),
          ]
        }
        // mounted + empty todos → fall through to setData (clears the plan)
        return [this.setData(path, todos)]
      }
      case "permission.required": {
        const requestId = String(event.payload.request_id)
        const path = `/permissions/${requestId}`
        const decision = String(event.payload.decision ?? "ask")
        const message = String(event.payload.message ?? "")
        const value: {
          requestId: string
          decision: string
          scope?: string
          message: string
          options?: string[]
          kind?: string
        } = {
          requestId,
          decision,
          message,
        }

        if (event.payload.kind !== undefined) {
          value.kind = String(event.payload.kind)
        }

        if (event.payload.scope !== undefined) {
          value.scope = String(event.payload.scope)
        }

        if (Array.isArray(event.payload.options)) {
          value.options = event.payload.options.map((option) => String(option))
        }

        if (!this.mountedPermissionRequestIds.has(requestId)) {
          this.mountedPermissionRequestIds.add(requestId)
          this.children.push(requestId)
          return [
            this.mountComponent(requestId, "PermissionCard", { sessionId: this.surfaceId, requestPath: { path } }),
            this.setData(path, value),
            this.rootOp(),
          ]
        }

        return [this.setData(path, value)]
      }
      case "run.completed":
        return []
      case "run.failed": {
        const id = `err_${event.run_id}`
        const path = `/messages/${id}`
        const value = `⚠️ ${String(event.payload.message ?? "")}`
        // 同一 run 多次 failed：只挂载一次错误 Message，后续仅更新错误文本。
        if (this.erroredRuns.has(event.run_id)) {
          return [this.setData(path, value)]
        }
        this.erroredRuns.add(event.run_id)
        this.children.push(id)
        return [
          this.mountComponent(id, "Message", { author: "ai", text: { path } }),
          this.setData(path, value),
          this.rootOp(),
        ]
      }
      default:
        return []
    }
  }
}
