#!/usr/bin/env bash
#
# End-to-end test for a built manifest-with-plugins image.
#
# Boots the image against a scratch PostgreSQL, waits for the Nest
# backend to bind its port, and asserts:
#
#   1. GET /api/v1/health      → HTTP 200, JSON {"status":"healthy",...}
#   2. GET /                   → HTTP 200, content-type text/html
#                                (i.e. the SolidJS dashboard loads, not
#                                Nest's default 404 for an unhandled route)
#   3. GET /assets/   → HTTP 200, content-type application/javascript
#                                (i.e. the dashboard's JS bundle is reachable)
#   4. Runtime plugin registry smoke inside the app container: requiring
#      `manifest-plugins` must expose enabled plugins, and
#      HeaderTierRouterPlugin.overrideRouting() must return a header-match
#      routing override for an in-memory header-tier fixture.
#   5. (MVP_UI=1 only) GET /api/v1/plugins → HTTP 200, JSON body with a
#                                top-level "plugins" array. When MVP_UI=1
#                                is set, a 404 or non-JSON response on this
#                                endpoint fails the script.
#
# This is the canonical validation that the image is a drop-in replacement
# for the upstream Manifest image. Symbol-only checks (does the compiled
# JS contain "applyRequestTransformPlugins") catch build-time regressions
# but not serve-static / dashboard / asset-pipeline regressions.
#
# Usage:
#   bash pipeline/e2e-test.sh <image:tag>
#
# Required tools: docker, curl, openssl, jq (for MVP_UI plugin route
# assertion), postgres client (only used implicitly via docker exec).
#
# Exit codes:
#   0  all checks passed
#   1  image does not exist locally
#   2  container did not become healthy within the timeout
#   3  one or more HTTP checks returned a non-200 status / wrong type
#   4  unexpected runtime error during the test
#   5  MVP_UI=1 was set but /api/v1/plugins is missing or non-JSON

set -uo pipefail

# ---- arguments + defaults ---------------------------------------------------

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <image:tag>" >&2
  echo "" >&2
  echo "Example:" >&2
  echo "  $0 manifest-with-plugins:0.1.0.d48a57483" >&2
  echo "" >&2
  echo "Env vars:" >&2
  echo "  PORT                    port to publish (default: 2099)" >&2
  echo "  HEALTH_TIMEOUT_SECONDS  how long to wait for /api/v1/health (default: 60)" >&2
  echo "  MVP_UI                  when 1, additionally assert /api/v1/plugins returns" >&2
  echo "                          HTTP 200 with a JSON body containing a plugins array." >&2
  echo "                          This is the gate for MVP-mode builds." >&2
  echo "  PLUGINS_PATH            override the plugins API path (default: /api/v1/plugins)" >&2
  echo "  TIER_ROUTING_SMOKE      when 1, additionally assert that configured" >&2
  echo "                          header_tiers rules (e.g. x-manifest-tier)" >&2
  echo "                          win over body.model for /v1/chat/completions." >&2
  echo "                          Regression fix for upstream 2ab748a6." >&2
  echo "                          Requires a header_tiers row to be seeded" >&2
  echo "                          out-of-band (see pipeline/README.md)." >&2
  exit 64
fi

IMAGE="$1"
PORT="${PORT:-2099}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
MVP_UI="${MVP_UI:-0}"
PLUGINS_PATH="${PLUGINS_PATH:-/api/v1/plugins}"
TIER_ROUTING_SMOKE="${TIER_ROUTING_SMOKE:-0}"

# ---- preflight --------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not on PATH" >&2
  exit 4
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not on PATH" >&2
  exit 4
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl not on PATH" >&2
  exit 4
fi
# MVP_UI requires jq to assert the plugins JSON array; we fail fast
# here (before the docker image check) so the user sees a clear
# error instead of a confusing 200-vs-non-JSON failure mid-test.
# Probe both presence AND functionality: a non-executable or stub
# `jq` on PATH would otherwise pass `command -v` and fail later with
# an unhelpful exit code.
if [[ "$MVP_UI" == "1" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: MVP_UI=1 requires 'jq' on PATH to validate /api/v1/plugins response" >&2
    exit 4
  fi
  if ! jq --version >/dev/null 2>&1; then
    echo "error: MVP_UI=1 found 'jq' on PATH but it is not functional (jq --version failed)" >&2
    exit 4
  fi
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: image '$IMAGE' not present in local docker" >&2
  echo "      pull it first: docker pull $IMAGE" >&2
  echo "      or build it:    bash pipeline/build-and-publish.sh --tag <t>" >&2
  exit 1
fi

# ---- helpers ----------------------------------------------------------------

# Names are per-PID so concurrent runs don't collide. We don't share
# between runs; this is throwaway.
RUN_ID="$$"
NET_NAME="mwp-e2e-${RUN_ID}"
PG_NAME="mwp-e2e-pg-${RUN_ID}"
APP_NAME="mwp-e2e-app-${RUN_ID}"

cleanup() {
  # Remove containers first (they depend on the network), then the net.
  docker rm -f "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log()  { printf '  %s\n' "$*"; }
fail() { printf '  FAIL: %s\n' "$*" >&2; exit "${2:-3}"; }

# Poll $1 until it returns 200 or $2 seconds elapse. Returns:
#   0  on 200 (ready)
#   2  on any other HTTP status (server is up but wrong response)
#   1  on timeout (server never came up)
wait_for_health() {
  local url="$1"
  local timeout_s="$2"
  local deadline=$(( $(date +%s) + timeout_s ))
  while (( $(date +%s) < deadline )); do
    local code
    # curl outputs `%{http_code}` (000 on connect failure) AND exits
    # non-zero on failure — the `|| echo` would then append another
    # 000. Strip it: take only the first 3 chars.
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null)"
    code="${code:0:3}"
    case "$code" in
      200) return 0 ;;
      000) : ;;  # not yet listening — keep polling
      *)   return 2 ;;
    esac
    sleep 1
  done
  return 1
}

# Capture response metadata into $RESP_CODE, $RESP_TYPE, $RESP_BYTES,
# $RESP_BODY (path to temp file with the body).
RESP_CODE=
RESP_TYPE=
RESP_BYTES=
RESP_BODY=

capture() {
  local url="$1"
  RESP_BODY="$(mktemp)"
  # curl's -w output is emitted even when curl exits non-zero (e.g.
  # connect-refused gives `000|application/octet-stream|0`), so the
  # `|| echo` fallback below would duplicate the fields. We use
  # `--fail-with-body` semantics via the explicit output parsing
  # instead: only run the echo fallback if curl produced no output at
  # all.
  local meta
  meta="$(curl -sS -o "$RESP_BODY" -w '%{http_code}|%{content_type}|%{size_download}' --max-time 10 "$url" 2>/dev/null)"
  if [[ -z "$meta" ]]; then
    meta='000|application/octet-stream|0'
  fi
  # Defensive: take only the first three pipe-delimited fields in case
  # content_type contained a `|` (unlikely but safe).
  IFS='|' read -r RESP_CODE RESP_TYPE RESP_BYTES < <(printf '%s' "$meta" | head -c 200)
}

# ---- step 1: scratch postgres ---------------------------------------------

echo "[1/4] starting scratch PostgreSQL on user-defined network"
docker network create --driver bridge "$NET_NAME" >/dev/null \
  || fail "could not create network $NET_NAME" 4
docker run -d --name "$PG_NAME" \
  --network "$NET_NAME" \
  -e POSTGRES_USER=myuser \
  -e POSTGRES_PASSWORD=mypassword \
  -e POSTGRES_DB=mwp_e2e \
  postgres:16 >/dev/null \
  || fail "could not start scratch postgres" 4
log "postgres container up"

# Wait for postgres to be ready (its own init takes ~2-3s).
for _ in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U myuser >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker exec "$PG_NAME" pg_isready -U myuser >/dev/null 2>&1; then
  fail "postgres did not become ready in 30s" 4
fi
log "postgres ready"

# ---- step 2: app container -------------------------------------------------

echo "[2/4] starting $IMAGE"
docker run -d --name "$APP_NAME" \
  --network "$NET_NAME" \
  -p "${PORT}:${PORT}" \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e DATABASE_URL="postgresql://myuser:mypassword@${PG_NAME}:5432/mwp_e2e" \
  -e PORT="$PORT" \
  -e NODE_ENV=development \
  -e MANIFEST_MODE=selfhosted \
  -e BIND_ADDRESS=0.0.0.0 \
  "$IMAGE" >/dev/null \
  || fail "could not start application container" 4
log "app container up (logs: docker logs $APP_NAME)"

# ---- step 3: wait for health ----------------------------------------------

echo "[3/4] waiting for http://127.0.0.1:${PORT}/api/v1/health (timeout: ${HEALTH_TIMEOUT_SECONDS}s)"
# Capture wait_for_health's exit code BEFORE branching, since $? inside
# the elif would refer to the if-condition's negation, not the function.
wait_for_health "http://127.0.0.1:${PORT}/api/v1/health" "$HEALTH_TIMEOUT_SECONDS"
health_rc=$?
case "$health_rc" in
  0) log "/api/v1/health is up" ;;
  2) fail "GET /api/v1/health returned non-200 within timeout" 2 ;;
  *) fail "GET /api/v1/health did not respond within ${HEALTH_TIMEOUT_SECONDS}s" 2 ;;
esac

# ---- step 4: dashboard + asset delivery ----------------------------------

echo "[4/4] validating dashboard delivery"

# (a) /api/v1/health — JSON
capture "http://127.0.0.1:${PORT}/api/v1/health"
[[ "$RESP_CODE" == "200" ]] \
  || fail "GET /api/v1/health → $RESP_CODE (expected 200)" 3
[[ "$RESP_TYPE" == application/json* ]] \
  || fail "GET /api/v1/health content-type: $RESP_TYPE (expected application/json)" 3
log "GET /api/v1/health          → 200 ($RESP_BYTES bytes, $RESP_TYPE)"

# (b) / — dashboard HTML (this is the canonical regression check — the
# root cause of the 404 bug was that the Dockerfile didn't copy the
# frontend dist into the runtime image).
capture "http://127.0.0.1:${PORT}/"
[[ "$RESP_CODE" == "200" ]] \
  || fail "GET / → $RESP_CODE (expected 200 — the frontend dist is missing or the serve-static middleware is misconfigured)" 3
[[ "$RESP_TYPE" == text/html* ]] \
  || fail "GET / content-type: $RESP_TYPE (expected text/html)" 3
if ! grep -q '<title>Manifest</title>' "$RESP_BODY"; then
  fail "GET / returned HTML but it doesn't contain '<title>Manifest</title>' — the dashboard index.html is wrong" 3
fi
log "GET /                       → 200 ($RESP_BYTES bytes, $RESP_TYPE, contains dashboard title)"

# (c) /assets/<bundled-js> — Vite asset path (catches asset-pipeline
# regressions where the HTML references a hash that the dist doesn't ship).
ASSET_FILE="$(grep -oE '/assets/[A-Za-z0-9_./-]+\.(js|css)' "$RESP_BODY" | head -1 || true)"
if [[ -n "$ASSET_FILE" ]]; then
  capture "http://127.0.0.1:${PORT}${ASSET_FILE}"
  [[ "$RESP_CODE" == "200" ]] \
    || fail "GET ${ASSET_FILE} → $RESP_CODE (expected 200 — Vite asset path is broken)" 3
  case "$RESP_TYPE" in
    application/javascript*|text/javascript*|application/x-javascript*|text/css*) ;;
    *) fail "GET ${ASSET_FILE} content-type: $RESP_TYPE (expected js/css)" 3 ;;
  esac
  log "GET ${ASSET_FILE}  → 200 ($RESP_BYTES bytes, $RESP_TYPE)"
else
  log "(skipped asset check — no /assets/* file found in dashboard HTML)"
fi

# (d) Runtime plugin registry smoke — assert the built image can require
# `manifest-plugins` from the same node_modules path the patched host uses,
# and that the routing override plugin is both installed and executable.
#
# This is intentionally self-contained: no seeded database rows, no providers,
# no real upstream request. It would have caught the production regression where
# `dist/` discovery looked for `plugin.ts`, found zero plugins, and booted with
# an empty registry even though the dashboard served successfully.
if docker exec "$APP_NAME" node -e '
const pkg = require("/app/node_modules/manifest-plugins");
const installed = pkg.getInstalledPlugins();
if (!Array.isArray(installed)) throw new Error("getInstalledPlugins() did not return an array");
if (!installed.some((plugin) => plugin.id === "header-tier-router")) {
  throw new Error(`header-tier-router missing from installed plugins: ${JSON.stringify(installed)}`);
}
if (!Array.isArray(pkg.plugins) || pkg.plugins.length === 0) {
  throw new Error("enabled plugin registry is empty");
}
const router = pkg.plugins.find((plugin) => typeof plugin.overrideRouting === "function");
if (!router) throw new Error("no enabled plugin exposes overrideRouting()");
const route = { provider: "anthropic", authType: "api_key", model: "claude-sonnet-4-5" };
const result = router.overrideRouting({
  agentId: "agent-smoke",
  tenantId: "tenant-smoke",
  apiMode: "chat_completions",
  body: { model: "openai/gpt-4o-mini" },
  headers: { "x-manifest-tier": "smoke-test" },
  requestedModel: "openai/gpt-4o-mini",
  discoveredModels: [{ id: route.model, provider: route.provider, authType: route.authType }],
  headerTiers: [{
    id: "smoke-tier",
    name: "Smoke Test",
    header_key: "x-manifest-tier",
    header_value: "smoke-test",
    enabled: true,
    sort_order: 0,
    badge_color: "#f59e0b",
    override_route: route,
    fallback_routes: null,
    output_modality: "text",
    response_mode: "buffered",
  }],
});
if (!result || result.reason !== "header-match" || result.header_tier_id !== "smoke-tier") {
  throw new Error(`HeaderTierRouterPlugin returned unexpected result: ${JSON.stringify(result)}`);
}
if (!result.route || result.route.model !== route.model) {
  throw new Error(`HeaderTierRouterPlugin returned wrong route: ${JSON.stringify(result)}`);
}
if (result.explicit_model_override !== false) {
  throw new Error(`HeaderTierRouterPlugin set explicit_model_override incorrectly: ${JSON.stringify(result)}`);
}
' >/dev/null; then
  log "plugin registry smoke      → pass (header-tier-router installed + overrideRouting returns header-match)"
else
  fail "plugin registry smoke failed — manifest-plugins is missing, empty, or header-tier-router is not executable in the built image" 3
fi

# (e) (MVP_UI=1 only) /api/v1/plugins — assert the upstream Manifest
# `PluginsController` is reachable and returns a JSON object with a
# `plugins` array. When MVP_UI is set, a 404 or non-JSON response
# fails the script with exit code 5. This is the MVP gate: the build
# is claiming to ship MVP UI, so the upstream must actually expose it.
if [[ "$MVP_UI" == "1" ]]; then
  capture "http://127.0.0.1:${PORT}${PLUGINS_PATH}"
  [[ "$RESP_CODE" == "200" ]] \
    || fail "GET ${PLUGINS_PATH} → $RESP_CODE (expected 200 — MVP_UI=1 requires the plugins API to be reachable; upstream Manifest must ship a PluginsController for this build)" 5
  [[ "$RESP_TYPE" == application/json* ]] \
    || fail "GET ${PLUGINS_PATH} content-type: $RESP_TYPE (expected application/json)" 5
  # Assert the JSON body has a top-level "plugins" array. We use jq
  # because shell JSON parsing is fragile; this is the canonical
  # check the pipeline's MVP gate relies on.
  if ! jq -e 'type == "object" and (.plugins | type == "array")' "$RESP_BODY" >/dev/null 2>&1; then
    fail "GET ${PLUGINS_PATH} JSON body does not contain a top-level 'plugins' array: $(cat "$RESP_BODY")" 5
  fi
  log "GET ${PLUGINS_PATH} → 200 (MVP_UI=1: JSON body has plugins array)"
fi

# (e) (TIER_ROUTING_SMOKE=1 only) /v1/chat/completions with x-manifest-tier
# — assert that configured `header_tiers` rules (e.g. `x-manifest-tier`)
# win over `body.model`. Regression fix for upstream commit 2ab748a6
# (PR #2350, 2026-06-29), which added an explicit-model early-return
# in `proxy.service.ts::resolveRouting()` that bypasses the upstream
# `resolveHeaderTier()` and silently ignores `x-manifest-tier` when
# the request body carries a concrete `body.model != "auto"`.
#
# How it works:
#   1. The pipeline runner seeds a `header_tiers` row whose
#      `header_key='x-manifest-tier'`, `header_value='smoke-test'`,
#      and `override_route={provider,auth_type,model}` pointing at a
#      cheap upstream (any configured provider works). The exact
#      provider/model is irrelevant — we only assert that the
#      routing decision honors the header.
#   2. This gate sends `POST /v1/chat/completions` with
#      `x-manifest-tier: smoke-test` AND `body.model: openai/gpt-4o-mini`
#      (a concrete non-`auto` model).
#   3. We capture the response headers and assert that
#      `X-Manifest-Tier: standard` and
#      `X-Manifest-Reason: header-match` are returned. The
#      configured tier name lives in routing metadata, but upstream
#      builds `X-Manifest-Tier` from `meta.tier`, not
#      `header_tier_name`. A `direct` tier or `direct` reason in
#      the response means the upstream regression is back.
#
# Failure exit code: 6 (distinct from MVP_UI's 5, so CI can
# disambiguate).
if [[ "$TIER_ROUTING_SMOKE" == "1" ]]; then
  # No new host dependencies — reuses the already-running app
  # container, curl, and grep. Avoids jq (which the upstream MVP
  # path already requires, but we don't need JSON parsing here).
  TIER_HEADER_NAME="${TIER_HEADER_NAME:-smoke-test}"
  TIER_BODY_MODEL="${TIER_BODY_MODEL:-openai/gpt-4o-mini}"
  TIER_EXPECTED_RESPONSE_TIER="standard"
  TIER_EXPECTED_RESPONSE_REASON="header-match"
  TIER_REQUEST_BODY=$(printf '{"model":"%s","messages":[{"role":"user","content":"ping"}],"stream":false}' "$TIER_BODY_MODEL")

  capture_post_json() {
    local url="$1"
    local body="$2"
    local header="$3"
    RESP_BODY="$(mktemp)"
    local meta
    meta="$(curl -sS -o "$RESP_BODY" -w '%{http_code}|%{content_type}|%{size_download}' \
      --max-time 10 \
      -H "Content-Type: application/json" \
      -H "$header" \
      -d "$body" \
      "$url" 2>/dev/null)"
    if [[ -z "$meta" ]]; then
      meta='000|application/octet-stream|0'
    fi
    IFS='|' read -r RESP_CODE RESP_TYPE RESP_BYTES < <(printf '%s' "$meta" | head -c 200)
    # Capture response headers to a separate file so we can grep
    # `X-Manifest-Tier` without the body. `curl -D` writes headers
    # to the dump file; we re-run the request only for the header
    # capture to keep the body file separate. This avoids the
    # pattern of re-parsing curl's `-D -` combined with `-o`.
    RESP_HEADERS="$(mktemp)"
    curl -sS -D "$RESP_HEADERS" -o /dev/null \
      --max-time 10 \
      -H "Content-Type: application/json" \
      -H "$header" \
      -d "$body" \
      "$url" >/dev/null 2>&1 || true
  }

  capture_post_json \
    "http://127.0.0.1:${PORT}/v1/chat/completions" \
    "$TIER_REQUEST_BODY" \
    "x-manifest-tier: ${TIER_HEADER_NAME}"

  # The upstream proxy may return 200 (request succeeded), 4xx
  # (auth/quota/upstream error), or 5xx (upstream broken). The
  # tier-routing smoke cares ONLY about the X-Manifest-Tier
  # response header, which is set by upstream's
  # `proxy-response-handler.ts` BEFORE the upstream HTTP call.
  # Any response status from the proxy is acceptable for this
  # smoke — we only assert the routing-decision header.
  RESP_TIER="$(grep -i '^x-manifest-tier:' "$RESP_HEADERS" | head -1 | awk -F': ' '{print $2}' | tr -d '\r\n' || true)"
  RESP_REASON="$(grep -i '^x-manifest-reason:' "$RESP_HEADERS" | head -1 | awk -F': ' '{print $2}' | tr -d '\r\n' || true)"

  rm -f "$RESP_HEADERS" "$RESP_BODY"

  # The smoke passes when upstream's observable routing headers
  # reflect a header-tier match: `X-Manifest-Tier` is built from
  # `meta.tier` (`standard`), and `X-Manifest-Reason` is
  # `header-match`. If the upstream regression is back, the response
  # tier and/or reason will be `direct` (the explicit-model override
  # path added by 2ab748a6).
  if [[ "$RESP_TIER" == "$TIER_EXPECTED_RESPONSE_TIER" && "$RESP_REASON" == "$TIER_EXPECTED_RESPONSE_REASON" ]]; then
    log "tier-routing smoke → 200 (header tier override honored: X-Manifest-Tier: standard X-Manifest-Reason: header-match; configured tier=$TIER_HEADER_NAME)"
  else
    fail "tier-routing smoke → header tier NOT honored. " \
         "Expected X-Manifest-Tier: standard and X-Manifest-Reason: header-match, " \
         "got X-Manifest-Tier: '$RESP_TIER' and X-Manifest-Reason: '$RESP_REASON'. " \
         "This means upstream commit 2ab748a6's explicit-model early-return " \
         "is bypassing the configured header_tiers rule — " \
         "body.model=$TIER_BODY_MODEL won over x-manifest-tier=$TIER_HEADER_NAME. " \
         "Fix: verify the routing-override host hook " \
         "(proxy-service-routing-override-host overlay) was applied to this " \
         "image and that the HeaderTierRouterPlugin is enabled in the plugin registry." 6
  fi
fi

# ---- success --------------------------------------------------------------

echo
echo "PASS: $IMAGE"
echo "  serves the Manifest dashboard on http://127.0.0.1:${PORT}/"
if [[ "$MVP_UI" == "1" ]]; then
  echo "  MVP_UI=1: /api/v1/plugins reachable with JSON body"
fi
if [[ "$TIER_ROUTING_SMOKE" == "1" ]]; then
  echo "  TIER_ROUTING_SMOKE=1: x-manifest-tier override honored"
fi
echo "  (containers will be torn down automatically)"
echo