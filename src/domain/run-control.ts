import { z } from "zod"

import type { AguiPayload, SessionEvent } from "./session-event"

// HITL 审批决策：镜像 kokoro-agent inbound.py 的 ResumeDecision 判别联合。各型按 type 判别、恰好
// 携带其必需字段；每个决策显式带 tool_id（同帧多工具的归属键，agent 据此重排对齐到 pending 顺序）。
const approveDecisionSchema = z
  .object({ type: z.literal("approve"), tool_id: z.string().min(1) })
  .strict()
const editDecisionSchema = z
  .object({
    type: z.literal("edit"),
    tool_id: z.string().min(1),
    // 用户改后的工具调用，整体替换模型原参数；具体形状由 agent Pydantic 边界校验，session 仅透传。
    edited_action: z.record(z.string(), z.unknown()),
  })
  .strict()
const rejectDecisionSchema = z
  .object({ type: z.literal("reject"), tool_id: z.string().min(1), message: z.string() })
  .strict()
const respondDecisionSchema = z
  .object({ type: z.literal("respond"), tool_id: z.string().min(1), message: z.string() })
  .strict()

export const resumeDecisionSchema = z.discriminatedUnion("type", [
  approveDecisionSchema,
  editDecisionSchema,
  rejectDecisionSchema,
  respondDecisionSchema,
])
export type ResumeDecision = z.infer<typeof resumeDecisionSchema>
export type ResumeDecisionType = ResumeDecision["type"]

export type PendingToolApproval = {
  tool_id: string
  allowed_decisions: ResumeDecisionType[]
}

export class RunControlDecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunControlDecisionError"
  }
}

// 出站到 agent 请求流（kokoro:runs:requests，与 run.request 同流）的 HITL 反向消息。run_id/session_id
// 由 session 据 URL 注入；agent 再以原 RunRequest 校验归属，避免跨 session 控制 run。
export const runResumeSchema = z
  .object({
    kind: z.literal("run.resume"),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    decisions: z.array(resumeDecisionSchema).min(1),
  })
  .strict()
export const runCancelSchema = z
  .object({
    kind: z.literal("run.cancel"),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
  })
  .strict()

// HTTP 入站体（web POST /control 的 JSON body）：与出站消息同形但不含 run_id（由路径参数注入）。
export const runControlBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.cancel") }).strict(),
  z
    .object({
      kind: z.literal("run.resume"),
      decisions: z.array(resumeDecisionSchema).min(1),
    })
    .strict(),
])
export type RunControlBody = z.infer<typeof runControlBodySchema>

export function pendingApprovalsFromEvents(
  events: readonly SessionEvent[],
  runId: string,
): PendingToolApproval[] {
  const pending = new Map<string, PendingToolApproval>()

  for (const event of events) {
    if (event.run_id !== runId) continue

    if (event.event === "tool.awaiting_approval") {
      const payload = event.payload as AguiPayload<"tool.awaiting_approval">
      pending.set(payload.tool_id, {
        tool_id: payload.tool_id,
        allowed_decisions: [...payload.allowed_decisions],
      })
      continue
    }

    if (event.event === "tool.returned") {
      const payload = event.payload as AguiPayload<"tool.returned">
      pending.delete(payload.tool_id)
      continue
    }

    if (event.event === "run.completed" || event.event === "run.failed") {
      pending.clear()
    }
  }

  return [...pending.values()]
}

export function validateResumeDecisions(
  decisions: readonly ResumeDecision[],
  pending: readonly PendingToolApproval[],
): void {
  if (pending.length === 0) {
    throw new RunControlDecisionError("run has no pending pause")
  }

  const pendingByTool = new Map(pending.map((approval) => [approval.tool_id, approval]))
  const seen = new Set<string>()

  for (const decision of decisions) {
    if (seen.has(decision.tool_id)) {
      throw new RunControlDecisionError(`duplicate decision for ${decision.tool_id}`)
    }
    seen.add(decision.tool_id)

    const approval = pendingByTool.get(decision.tool_id)
    if (approval === undefined) {
      throw new RunControlDecisionError(`unknown pending tool ${decision.tool_id}`)
    }
    if (!approval.allowed_decisions.includes(decision.type)) {
      throw new RunControlDecisionError(
        `${decision.type} is not allowed for ${decision.tool_id}`,
      )
    }
  }

  for (const approval of pending) {
    if (!seen.has(approval.tool_id)) {
      throw new RunControlDecisionError(`missing decision for ${approval.tool_id}`)
    }
  }
}
