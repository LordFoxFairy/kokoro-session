import { z } from "zod"

export const permissionDecisionSchema = z.enum(["ask", "allow", "deny"])

export const permissionScopeSchema = z.enum(["once", "session"])

export const permissionKindSchema = z.enum(["permission", "circuit_breaker"])

export const permissionOptionSchema = z.enum(["once", "session", "deny"])

export const permissionRequiredPayloadSchema = z
  .object({
    request_id: z.string().min(1),
    decision: permissionDecisionSchema,
    message: z.string(),
    options: z.array(permissionOptionSchema).optional(),
    kind: permissionKindSchema,
    scope: permissionScopeSchema.optional(),
  })
  .strict()

export const permissionDecisionBodySchema = z.union([
  z
    .object({
      decision: z.literal("allow"),
      scope: permissionScopeSchema,
    })
    .strict(),
  z
    .object({
      decision: z.literal("deny"),
    })
    .strict(),
])

export function permissionRequestIdForRun(runId: string): string {
  return `perm_${runId}`
}

export type PermissionRequiredPayload = z.infer<typeof permissionRequiredPayloadSchema>
export type PermissionDecisionBody = z.infer<typeof permissionDecisionBodySchema>
