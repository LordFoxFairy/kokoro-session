export function toSseChunk(event: unknown) {
  return `data: ${JSON.stringify(event)}\n\n`
}
