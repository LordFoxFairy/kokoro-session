#!/usr/bin/env bash
# 真·跨进程 e2e 门禁：redis live 总线 + sqlite 历史。起真 redis(docker) + 真 session server
# (bun run src/main.ts)，驱动一个 run 走完整链路，并做决定性证明——删掉 redis live 流后，
# 全新 SSE 仍能从 sqlite 全量重放历史（= redis 减负成立）。需要 docker。
set -u

REDIS_PORT="${REDIS_PORT:-6399}"
SESS_PORT="${SESS_PORT:-3013}"
DB="${DB:-/tmp/kokoro-e2e-msgstore.db}"
CONTAINER="kokoro-e2e-redis"
SERVER_PID=""

cleanup() {
  # wait 收尸：抑制 shell job-control 在后台进程被杀时打出的 "Terminated" 噪声。
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  lsof -ti "tcp:$SESS_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  rm -f "$DB" "$DB-wal" "$DB-shm"
}
trap cleanup EXIT

cd "$(dirname "$0")/.." || exit 1
rm -f "$DB" "$DB-wal" "$DB-shm"

echo "=== start redis :$REDIS_PORT ==="
docker rm -f "$CONTAINER" >/dev/null 2>&1
docker run -d --name "$CONTAINER" -p "$REDIS_PORT:6379" redis:7 >/dev/null || { echo "redis start FAILED"; exit 1; }
for _ in $(seq 1 20); do docker exec "$CONTAINER" redis-cli ping >/dev/null 2>&1 && { echo "redis ready"; break; }; sleep 0.5; done

echo "=== start session server (redis live + sqlite history) :$SESS_PORT ==="
KOKORO_STREAM_BACKEND=redis KOKORO_REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
KOKORO_MESSAGE_STORE_BACKEND=sqlite KOKORO_MESSAGE_STORE_DB="$DB" \
KOKORO_SESSION_PORT="$SESS_PORT" \
bun run src/main.ts >/tmp/kokoro-e2e-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$SESS_PORT/nope" && { echo "server ready (pid $SERVER_PID)"; break; }; sleep 0.5; done

echo "=== run e2e client ==="
E2E_SESS_URL="http://127.0.0.1:$SESS_PORT" \
E2E_REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
E2E_DB="$DB" \
bun run scripts/redis-sqlite-e2e.client.ts
RC=$?
[ "$RC" -ne 0 ] && { echo "--- server log ---"; tail -20 /tmp/kokoro-e2e-server.log; }
exit "$RC"
