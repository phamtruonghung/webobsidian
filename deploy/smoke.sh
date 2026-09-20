#!/usr/bin/env bash
# Smoke test a *running* WebObsidian deployment over HTTP.
#
#   deploy/smoke.sh [base-url]
#
# Reads the deployment's own env (ENV_FILE) and data volume to know what to expect, so it works both
# for a docker deployment (LXC 107) and for a locally built server. It asserts behaviour that only
# exists in this fork's merged upstream PRs, so it doubles as "is the fork build actually live?":
#   - GET /auth/status returns ONLY { passwordSet }  (upstream v0.1.1 also leaked mustChangePassword — PR #15)
#   - 123456 is refused whenever any credential is configured (PRs #4 + #15), accepted on a bare install
#   - the configured operator password still logs in
# Never prints a secret. Exit code 0 = all checks passed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/root/webobsidian/.env}"
PROJECT="${PROJECT:-webobsidian}"
PORT_DEFAULT="${PORT:-8787}"
BASE="${1:-${SELF_URL:-http://127.0.0.1:$PORT_DEFAULT}}"
BASE="${BASE%/}"

pass=0; fail=0
redact() { sed "s/$1/***/g"; }   # replacement for a secret value in output

chk() { # chk <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1  ->  $3"; pass=$((pass+1))
  else echo "  FAIL  $1  expected '$2' got '$3'"; fail=$((fail+1)); fi
}

env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -1 | sed 's/^["'"'"']//; s/["'"'"']$//'
}

http() { # http <method> <path> [data] -> "<code> <body>"
  local method="$1" path="$2" data="${3:-}" out code
  if [[ -n "$data" ]]; then
    out="$(curl -s -m 15 -o /tmp/wo-smoke-body -w '%{http_code}' -X "$method" "$BASE$path" \
            -H 'Content-Type: application/json' -d "$data")"
  else
    out="$(curl -s -m 15 -o /tmp/wo-smoke-body -w '%{http_code}' -X "$method" "$BASE$path")"
  fi
  code="$out"
  echo "$code $(tr -d '\n' </tmp/wo-smoke-body | head -c 400)"
}

login() { # login <password> -> "<code> <mustChangePassword|absent>"
  local code
  code="$(curl -s -m 15 -o /tmp/wo-smoke-login -w '%{http_code}' -X POST "$BASE/auth/login" \
          -H 'Content-Type: application/json' -d "{\"password\":\"$1\"}")"
  local flag
  flag="$(python3 -c "import json;print(json.load(open('/tmp/wo-smoke-login')).get('mustChangePassword','absent'))" 2>/dev/null || echo unparseable)"
  echo "$code $flag"
}

echo "smoke: $BASE (env: $ENV_FILE)"

# 1. liveness
read -r code body < <(http GET /healthz)
chk "GET /healthz returns ok" "200 {\"ok\":true}" "$code $body"

# 2. the SPA is served
body="$(curl -s -m 15 "$BASE/" | tr -d '\n' | head -c 4000)"
if [[ "$body" == *'<div id="root">'* ]]; then
  echo "  PASS  GET / serves the SPA bundle"; pass=$((pass+1))
else
  echo "  FAIL  GET / did not serve the SPA bundle (got: $(head -c 120 <<<"$body"))"; fail=$((fail+1))
fi

# 3. fork marker: /auth/status must not expose mustChangePassword (PR #15)
read -r code body < <(http GET /auth/status)
keys="$(printf '%s' "$body" | python3 -c "import json,sys; print(sorted(json.load(sys.stdin).keys()))" 2>/dev/null || echo unparseable)"
chk "GET /auth/status exposes only passwordSet (fork marker)" "['passwordSet']" "$keys"

# 4. credentials configured? (env override or a hash in the data volume)
env_pw="$(env_get WEBOBSIDIAN_PASSWORD)"
settings="/var/lib/docker/volumes/${PROJECT}_webobsidian-data/_data/settings.json"
has_hash="unknown"
if [[ -f "$settings" ]]; then
  has_hash="$(python3 -c "import json; a=json.load(open('$settings'))['auth']; print('yes' if (a.get('userPasswordHash') or a.get('passwordHash')) else 'no')" 2>/dev/null || echo unknown)"
fi
configured="no"
[[ -n "$env_pw" || "$has_hash" == "yes" ]] && configured="yes"

if [[ "$configured" == "yes" ]]; then
  chk "123456 is refused (credential configured)" "401 absent" "$(login 123456 | sed "s/$env_pw/***/g")"
else
  chk "123456 works on a bare install" "200 True" "$(login 123456)"
fi

if [[ -n "$env_pw" ]]; then
  result="$(login "$env_pw")"
  chk "the configured operator password logs in" "200 False" "${result//$env_pw/***}"
else
  echo "  SKIP  operator-password login (WEBOBSIDIAN_PASSWORD empty; UI password only)"
fi

echo
echo "RESULT: $pass passed, $fail failed"
exit $((fail > 0))
