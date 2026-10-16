#!/usr/bin/env bash
#
# End-to-end smoke test. Requires the gateway to be running:
#   npm start
#
# Usage: BASE_URL=http://127.0.0.1:8787 bash test/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
AUTH_HEADER=()
if [[ -n "${AMIKOM_GATEWAY_KEY:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${AMIKOM_GATEWAY_KEY}")
fi

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

echo "== health =="
curl -fsS "${BASE_URL}/health" | grep -q '"status":"ok"' && pass "health ok" || fail "health"

echo "== models =="
curl -fsS "${BASE_URL}/v1/models" | grep -q '"object":"list"' && pass "models listed" || fail "models"

echo "== non-streaming =="
NON_STREAM="$(curl -fsS "${BASE_URL}/v1/chat/completions" \
  "${AUTH_HEADER[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"miko","stream":false,"messages":[{"role":"user","content":"apa itu amikom? jawab satu kalimat"}]}')"
echo "$NON_STREAM" | grep -q '"object":"chat.completion"' && pass "chat.completion returned" || fail "non-streaming object"
echo "$NON_STREAM" | grep -q '"finish_reason":"stop"' && pass "finish_reason present" || fail "finish_reason"
echo "$NON_STREAM" | grep -q '"usage"' && pass "usage present" || fail "usage"

echo "== streaming =="
STREAM="$(curl -fsSN "${BASE_URL}/v1/chat/completions" \
  "${AUTH_HEADER[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"miko","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"apa itu amikom? jawab satu kalimat"}]}')"
echo "$STREAM" | grep -q '"object":"chat.completion.chunk"' && pass "chunked stream" || fail "stream chunks"
echo "$STREAM" | grep -q '"finish_reason":"stop"' && pass "finish_reason in stream" || fail "stream finish_reason"
echo "$STREAM" | grep -q '^data: \[DONE\]' && pass "[DONE] terminator" || fail "[DONE]"

echo "== auth =="
if [[ -n "${AMIKOM_GATEWAY_KEY:-}" ]]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/models")"
  [[ "$CODE" == "401" ]] && pass "unauthenticated request rejected" || fail "auth (got $CODE)"
fi

echo
echo "All smoke tests passed."
