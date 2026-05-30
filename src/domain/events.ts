const sessionEventNames = [
  "session.created",
  "run.created",
  "message.delta",
  "message.completed",
  "run.completed",
  "run.failed",
] as const

export type SessionEventName = (typeof sessionEventNames)[number]

export type SessionEvent = {
  event: SessionEventName
  event_id: string
  session_id: string
  conversation_id: string
  run_id: string
  cursor: string
  timestamp: string
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSessionEventName(value: unknown): value is SessionEventName {
  return typeof value === "string" && sessionEventNames.includes(value as SessionEventName)
}

// session 侧先严格守住传输 envelope，避免把脏事件写入 replay。
export function parseSessionEvent(input: unknown): SessionEvent {
  if (!isRecord(input)) {
    throw new Error("session event must be an object")
  }

  const {
    event,
    event_id,
    session_id,
    conversation_id,
    run_id,
    cursor,
    timestamp,
    payload,
  } = input

  if (!isSessionEventName(event)) {
    throw new Error("session event has an unsupported event name")
  }

  if (typeof event_id !== "string" || !event_id) {
    throw new Error("session event is missing event_id")
  }

  if (typeof session_id !== "string" || !session_id) {
    throw new Error("session event is missing session_id")
  }

  if (typeof conversation_id !== "string" || !conversation_id) {
    throw new Error("session event is missing conversation_id")
  }

  if (typeof run_id !== "string" || !run_id) {
    throw new Error("session event is missing run_id")
  }

  if (typeof cursor !== "string" || !cursor) {
    throw new Error("session event is missing cursor")
  }

  if (typeof timestamp !== "string" || !timestamp) {
    throw new Error("session event is missing timestamp")
  }

  if (!isRecord(payload)) {
    throw new Error("session event is missing payload")
  }

  return {
    event,
    event_id,
    session_id,
    conversation_id,
    run_id,
    cursor,
    timestamp,
    payload,
  }
}
