import { runRequestSchema } from "../domain/run-request"
import type { AgentRunInput, AttachmentRef } from "../domain/agent-run-input"
import type { SessionStore } from "./session-store"
import type { StreamProtocol } from "./event-stream"
import { REQUESTS_STREAM } from "./stream-names"

export type StartRunInput = {
  siteId: string
  userId: string
  workspaceId?: string | null
  projectId?: string | null
  sessionId: string
  idempotencyKey: string
  content: string
  attachments?: AttachmentRef[]
  executionStyle?: "fast" | "thinking"
  permissionMode?: "auto" | "default" | "plan"
  selectedSkillIds?: string[]
  selectedMcpServerIds?: string[]
  selectedToolNames?: string[]
}

export type StartRunDependencies = {
  bus: StreamProtocol
  sessionStore: SessionStore
}

export type StartRunResult = {
  messageId: string
  assistantMessageId: string
  runId: string
}

export async function startRun(
  input: StartRunInput,
  dependencies: StartRunDependencies,
): Promise<StartRunResult> {
  const stored = await dependencies.sessionStore.startRun({
    siteId: input.siteId,
    sessionId: input.sessionId,
    ownerUserId: input.userId,
    content: input.content,
    idempotencyKey: input.idempotencyKey,
  })
  const messages = await dependencies.sessionStore.listMessages(input.siteId, input.sessionId)
  const agentRunInput: AgentRunInput = {
    siteId: input.siteId,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId,
    runId: stored.runId,
    userId: input.userId,
    inputMessageId: stored.userMessageId,
    assistantMessageId: stored.assistantMessageId,
    context: {
      recentMessages: messages.map((message) => ({
        messageId: message.messageId,
        role: message.role,
        content: message.content,
      })),
      summary: null,
      artifactRefs: [],
      toolResultRefs: [],
      userProvidedFiles: input.attachments ?? [],
    },
    modelRuntime: {
      provider: process.env.KOKORO_MODEL_PROVIDER ?? "default",
      model: process.env.KOKORO_MODEL_NAME ?? "default",
    },
    executionStyle: input.executionStyle ?? "fast",
    permissionMode: input.permissionMode ?? "auto",
    backendPolicy: {
      backend: "default",
    },
    enabledSkills: input.selectedSkillIds ?? [],
    enabledMcpServers: input.selectedMcpServerIds ?? [],
    enabledTools: input.selectedToolNames ?? [],
    traceContext: {
      requestId: input.idempotencyKey,
    },
  }

  // 出站请求前先过严格 schema：拒绝空 input / 多余键，不将脏请求写进流。
  const request = runRequestSchema.parse({
    kind: "run.request",
    site_id: input.siteId,
    run_id: stored.runId,
    session_id: input.sessionId,
    agent_run_input: agentRunInput,
  })

  await dependencies.bus.publish(REQUESTS_STREAM, request)
  return {
    messageId: stored.userMessageId,
    assistantMessageId: stored.assistantMessageId,
    runId: stored.runId,
  }
}
