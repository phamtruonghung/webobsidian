#!/usr/bin/env bash
# Runtime smoke test for the features this fork merged from upstream PRs that unit
# tests cannot cover end-to-end: the auth hardening (#4 + #15), the SIGTERM
# graceful shutdown (#27) and vault symlinks through the HTTP API (#23).
#
#   npm run build && scripts/smoke-test.sh
#
# Boots the built server three times (fresh install / operator override / symlinked
# vault) on a free-ish local port against throwaway data + vault dirs, drives it
# with curl, then asserts the responses and the shutdown log.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
[[ -f server/dist/index.js ]] || { echo "build first: npm run build" >&2; exit 64; }

PORT="${SMOKE_PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp)"
pass=0; fail=0

chk() { # chk <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  PASS  $1  ->  $3"; pass=$((pass+1))
  else
    echo "  FAIL  $1  expected '$2' got '$3'"; fail=$((fail+1))
  fi
}

start_server() { # start_server <env-assignment...>
  DATA_DIR="$(mktemp -d)" VAULT_PATH="$(mktemp -d)" PORT="$PORT" HOST=127.0.0.1 "$@" \
    node server/dist/index.js >>"$LOG" 2>&1 &
  SRV=$!
  for _ in $(seq 1 60); do
    curl -fsS -m 1 "$BASE/healthz" >/dev/null 2>&1 && return 0
    kill -0 $SRV 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

login() { # login <password>  -> "<http status> <mustChangePassword|absent>"
  local code
  code="$(curl -s -o /tmp/wo-login.json -w '%{http_code}' -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' -d "{\"password\":\"$1\"}")"
  local flag
  flag="$(python3 -c "import json;print(json.load(open('/tmp/wo-login.json')).get('mustChangePassword','absent'))" 2>/dev/null || echo unparseable)"
  echo "$code $flag"
}

echo "== scenario A: fresh install (no override) =="
if start_server env; then
  chk "GET /auth/status has no mustChangePassword (#15)" "['passwordSet']" \
      "$(curl -s "$BASE/auth/status" | python3 -c "import json,sys;print(sorted(json.load(sys.stdin).keys()))")"
  chk "GET /healthz reports ok + version + build" "ok 0.1.1" \
      "$(curl -s "$BASE/healthz" | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d.get('ok') else 'not-ok', d.get('version','?'), d.get('build','?') if d.get('build') else 'missing')" | awk '{print $1, $2}')"
  echo "  INFO  /healthz build: $(curl -s "$BASE/healthz" | python3 -c "import json,sys;print(json.load(sys.stdin).get('build','?'))")"
  chk "login 123456 on a fresh install: accepted, change forced" "200 True" "$(login 123456)"
else
  echo "  FAIL  server did not start (scenario A)"; fail=$((fail+1))
fi
kill -TERM $SRV 2>/dev/null; wait $SRV 2>/dev/null
chk "graceful shutdown logged every step incl. the signal (#27)" "5" \
    "$(grep -c '\[shutdown\]' "$LOG")"
chk "no shutdown error" "0" "$(grep -c '\[shutdown\] error' "$LOG")"

echo "== scenario B: WEBOBSIDIAN_PASSWORD override set =="
before="$(grep -c '\[shutdown\]' "$LOG")"
if start_server env WEBOBSIDIAN_PASSWORD='correct-horse-battery'; then
  chk "login 123456 with an override: refused (#4 + #15)" "401 absent" "$(login 123456)"
  chk "login with the override password: accepted, no forced change" "200 False" \
      "$(login correct-horse-battery)"
  kill -TERM $SRV 2>/dev/null; wait $SRV 2>/dev/null
  chk "second boot shut down gracefully too" "5" "$(( $(grep -c '\[shutdown\]' "$LOG") - before ))"
else
  echo "  FAIL  server did not start (scenario B)"; fail=$((fail+1))
fi

echo "== scenario C: symlinked folder inside the vault (#23) =="
VAULT_C="$(mktemp -d)"; OUTSIDE_C="$(mktemp -d)"
mkdir -p "$OUTSIDE_C/shared"
printf '# from the linked folder' > "$OUTSIDE_C/shared/linked-note.md"
printf 'my own note' > "$VAULT_C/local.md"
ln -s "$OUTSIDE_C/shared" "$VAULT_C/linked"
DATA_DIR="$(mktemp -d)" VAULT_PATH="$VAULT_C" ALLOWED_ROOTS="$OUTSIDE_C" PORT="$PORT" HOST=127.0.0.1 \
  node server/dist/index.js >>"$LOG" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do curl -fsS -m 1 "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s -c /tmp/wo-cookies.txt -o /dev/null -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' -d '{"password":"123456"}'
chk "GET /api/files lists the symlinked folder" "['linked-note.md']" \
    "$(curl -s -b /tmp/wo-cookies.txt "$BASE/api/files" \
       | python3 -c "import json,sys; t=json.load(sys.stdin); print([c['name'] for c in next(f for f in t['children'] if f['name']=='linked')['children']])")"
code_c="$(curl -s -o /tmp/wo-c.json -w '%{http_code}' -b /tmp/wo-cookies.txt \
  "$BASE/api/files/content?path=linked%2Flinked-note.md")"
chk "GET /api/files/content reads through the symlink" "200 # from the linked folder" \
    "$code_c $(python3 -c "import json;print(json.load(open('/tmp/wo-c.json'))['content'])")"
kill -TERM $SRV 2>/dev/null; wait $SRV 2>/dev/null

echo
echo "shutdown log (last boot):"
grep '\[shutdown\]' "$LOG" | tail -5 | sed 's/^/  /'
echo
echo "RESULT: $pass passed, $fail failed"
exit $((fail > 0))
