// 会话实时总线：relay 把归一化信封发布到此流供 SSE 实时 tail。
// 它不再是持久真源（那是 SessionStore），只是瞬时 fanout，故按 MAXLEN 有界，卸下 redis RAM 负担。
// 流名一条 per session；SSE 正确性由「DB 历史 + live tail」桥兜底，不依赖本流的保留时长。
export function liveStream(sessionId: string): string {
  return `kokoro:session:${sessionId}:live`
}

// live 窗口上限：只需覆盖「SSE 读完 DB 历史→接上实时」的追赶窗口；更老的历史一律走 DB。
export const LIVE_STREAM_MAXLEN = 512
