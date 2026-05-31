import { describe, expect, it } from "bun:test"
import { A2uiProjector } from "../src/application/a2ui-projector"
import type { SessionEvent } from "../src/domain/events"

function ev(event: SessionEvent["event"], payload: Record<string, unknown>, n: number): SessionEvent {
  return {
    event,
    event_id: `evt_${n}`,
    session_id: "ses_1",
    conversation_id: "conv_1",
    run_id: "run_1",
    cursor: `run_1:${String(n).padStart(4, "0")}`,
    timestamp: "2026-05-30T00:00:00.000Z",
    payload,
  }
}

describe("A2uiProjector", () => {
  it("creates surface + Thread root on run.created (once)", () => {
    const p = new A2uiProjector("ses_1")
    const ops = p.project(ev("run.created", { run_id: "run_1" }, 1))
    expect(ops[0]).toEqual({ version: "v0.9", createSurface: { surfaceId: "ses_1", catalogId: "kokoro/chat/v1" } })
    expect(ops[1]).toEqual({
      version: "v0.9",
      updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: [] }] },
    })
    // second run.created → no ops
    expect(p.project(ev("run.created", { run_id: "run_1" }, 2))).toEqual([])
  })

  it("session.created yields nothing", () => {
    const p = new A2uiProjector("ses_1")
    expect(p.project(ev("session.created", { session_id: "ses_1", conversation_id: "conv_1", owner_id: "x" }, 1))).toEqual([])
  })

  it("projects thinking.summary into ThinkingBlock + dataModel + root child", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const ops = p.project(ev("thinking.summary", { run_id: "run_1", summary: "想一下" }, 2))
    expect(ops).toEqual([
      { version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "th_1", component: "ThinkingBlock", summary: { path: "/thinking/th_1" } }] } },
      { version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/thinking/th_1", value: "想一下" } },
      { version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["th_1"] }] } },
    ])
  })

  it("projects tool start→complete with stable id and status flip", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const started = p.project(ev("tool.started", { tool_call_id: "run_1:tool_0001", tool_name: "echo_search" }, 2))
    expect(started[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "run_1:tool_0001", component: "ToolCard", toolName: "echo_search", status: "running" }] } })
    expect(started[1]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["run_1:tool_0001"] }] } })
    const done = p.project(ev("tool.completed", { tool_call_id: "run_1:tool_0001", tool_name: "echo_search", status: "ok" }, 3))
    expect(done).toEqual([{ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "run_1:tool_0001", component: "ToolCard", toolName: "echo_search", status: "ok" }] } }])
  })

  it("accumulates message deltas into dataModel and mounts Message once", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const d1 = p.project(ev("message.delta", { message_id: "run_1:msg_0001", delta: "好的，", role: "assistant" }, 2))
    expect(d1[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "run_1:msg_0001", component: "Message", author: "ai", text: { path: "/messages/run_1:msg_0001" } }] } })
    expect(d1[1]).toEqual({ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/run_1:msg_0001", value: "好的，" } })
    expect(d1[2]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["run_1:msg_0001"] }] } })
    const d2 = p.project(ev("message.delta", { message_id: "run_1:msg_0001", delta: "结果是…", role: "assistant" }, 3))
    expect(d2).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/run_1:msg_0001", value: "好的，结果是…" } }])
  })

  it("message.completed overwrites accumulated text with final content", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    p.project(ev("message.delta", { message_id: "run_1:msg_0001", delta: "好的", role: "assistant" }, 2))
    const done = p.project(ev("message.completed", { message_id: "run_1:msg_0001", role: "assistant", content: "好的，最终答案。" }, 3))
    expect(done).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/run_1:msg_0001", value: "好的，最终答案。" } }])
  })

  it("maps message.delta role:user to author:user", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const d1 = p.project(ev("message.delta", { message_id: "run_1:msg_0001", delta: "在吗", role: "user" }, 2))
    expect(d1[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "run_1:msg_0001", component: "Message", author: "user", text: { path: "/messages/run_1:msg_0001" } }] } })
  })

  it("run.failed appends an error Message", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const ops = p.project(ev("run.failed", { run_id: "run_1", error_kind: "Boom", message: "炸了" }, 2))
    expect(ops[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "err_run_1", component: "Message", author: "ai", text: { path: "/messages/err_run_1" } }] } })
    expect(ops[1]).toEqual({ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/err_run_1", value: "⚠️ 炸了" } })
    expect(ops[2]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["err_run_1"] }] } })
  })

  it("dedupes repeated run.failed for same run_id (one err child, text updates)", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    p.project(ev("run.failed", { run_id: "run_1", message: "炸了" }, 2))
    const second = p.project(ev("run.failed", { run_id: "run_1", message: "又炸了" }, 3))
    // 第二次只更新文本，不再 mount / 不再 push child
    expect(second).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/messages/err_run_1", value: "⚠️ 又炸了" } }])
    // 触发一次 thinking 强制吐出 rootOp，验证 children 仅含一个 err_ child
    const ops = p.project(ev("thinking.summary", { run_id: "run_1", summary: "x" }, 4))
    const rootOp = ops[2]
    expect(rootOp).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["err_run_1", "th_1"] }] } })
  })

  it("run.completed yields nothing", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    expect(p.project(ev("run.completed", { run_id: "run_1", status: "completed" }, 2))).toEqual([])
  })

  it("projects plan.updated into a Plan component mounted once + dataModel replace", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const first = p.project(ev("plan.updated", { plan_id: "run_1:plan", todos: [{ content: "a", status: "pending" }] }, 2))
    expect(first[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "run_1:plan", component: "Plan", todosPath: { path: "/plans/run_1:plan" } }] } })
    expect(first[1]).toEqual({ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/plans/run_1:plan", value: [{ content: "a", status: "pending" }] } })
    expect(first[2]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["run_1:plan"] }] } })
    // second plan.updated: dataModel only, no re-mount / no duplicate child
    const second = p.project(ev("plan.updated", { plan_id: "run_1:plan", todos: [{ content: "a", status: "completed" }] }, 3))
    expect(second).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/plans/run_1:plan", value: [{ content: "a", status: "completed" }] } }])
  })

  it("projects permission.required ask into PermissionCard mount + dataModel", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    const ask = p.project(ev("permission.required", { request_id: "perm_run_1", decision: "ask", message: "Need permission", options: ["once", "session", "deny"], kind: "permission" }, 2))
    expect(ask[0]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "perm_run_1", component: "PermissionCard", sessionId: "ses_1", requestPath: { path: "/permissions/perm_run_1" } }] } })
    expect(ask[1]).toEqual({ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/permissions/perm_run_1", value: { requestId: "perm_run_1", decision: "ask", message: "Need permission", options: ["once", "session", "deny"], kind: "permission" } } })
    expect(ask[2]).toEqual({ version: "v0.9", updateComponents: { surfaceId: "ses_1", components: [{ id: "root", component: "Thread", children: ["perm_run_1"] }] } })
  })

  it("updates permission.required resolved in-place without remounting", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    p.project(ev("permission.required", { request_id: "perm_run_1", decision: "ask", message: "Need permission", options: ["once", "session", "deny"], kind: "permission" }, 2))
    const resolved = p.project(ev("permission.required", { request_id: "perm_run_1", decision: "allow", scope: "session", message: "Allowed", kind: "permission" }, 3))
    expect(resolved).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/permissions/perm_run_1", value: { requestId: "perm_run_1", decision: "allow", scope: "session", message: "Allowed", kind: "permission" } } }])
  })


  it("plan.updated with empty todos mounts nothing until non-empty", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    expect(p.project(ev("plan.updated", { plan_id: "run_1:plan", todos: [] }, 2))).toEqual([])
  })

  it("plan.updated with empty todos after mount clears the plan (dataModel only, no re-mount)", () => {
    const p = new A2uiProjector("ses_1")
    p.project(ev("run.created", { run_id: "run_1" }, 1))
    p.project(ev("plan.updated", { plan_id: "run_1:plan", todos: [{ content: "a", status: "pending" }] }, 2))
    const cleared = p.project(ev("plan.updated", { plan_id: "run_1:plan", todos: [] }, 3))
    expect(cleared).toEqual([{ version: "v0.9", updateDataModel: { surfaceId: "ses_1", path: "/plans/run_1:plan", value: [] } }])
  })
})
