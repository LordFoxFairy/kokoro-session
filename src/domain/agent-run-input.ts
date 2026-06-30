import { z } from "zod"

const stringArraySchema = z.array(z.string().min(1))

export const attachmentRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
  })
  .strict()

export const agentRunInputSchema = z
  .object({
    siteId: z.string().min(1),
    workspaceId: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    userId: z.string().min(1),
    inputMessageId: z.string().min(1),
    assistantMessageId: z.string().min(1),
    context: z
      .object({
        recentMessages: z.array(
          z
            .object({
              messageId: z.string().min(1),
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            })
            .strict(),
        ),
        summary: z.string().nullable(),
        artifactRefs: z.array(attachmentRefSchema),
        toolResultRefs: z.array(z.string().min(1)),
        userProvidedFiles: z.array(attachmentRefSchema),
      })
      .strict(),
    modelRuntime: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
      })
      .strict(),
    executionStyle: z.enum(["fast", "thinking"]),
    permissionMode: z.enum(["auto", "default", "plan"]),
    backendPolicy: z
      .object({
        backend: z.enum(["default", "state", "local_shell", "e2b", "custom"]),
      })
      .strict(),
    enabledSkills: stringArraySchema,
    enabledMcpServers: stringArraySchema,
    enabledTools: stringArraySchema,
    traceContext: z
      .object({
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export type AttachmentRef = z.infer<typeof attachmentRefSchema>
export type AgentRunInput = z.infer<typeof agentRunInputSchema>
