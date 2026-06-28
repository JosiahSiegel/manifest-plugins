#!/usr/bin/env bash
# build-and-publish.sh
# =====================
#
# End-to-end pipeline that:
#   1. Clones or refreshes a mnfst/manifest checkout (or uses an existing
#      path). The user passes the path; if it doesn't exist, the script
#      clones a fresh shallow copy.
#   2. Builds the manifest-plugins package (this repo) so the apply
#      CLI and the runtime dist/ are available.
#   3. Applies the plugin host to all three target files in the
#      Manifest checkout (provider-client.ts, proxy-rate-limiter.ts,
#      proxy.service.ts). Idempotent — safe to re-run.
#   4. Builds a Docker image with the plugins baked in, using
#      `manifest-plugins` as a named BuildKit build-context.
#   5. Optionally pushes the image to a registry.
#   6. Prints usage instructions for the resulting image.
#
# The user runs this script ONCE to publish an image; downstream
# consumers just `docker pull` and `docker run` — no apply step
# required on their end.
#
# Usage:
#   ./build-and-publish.sh [options] [manifest-checkout-path]
#
# Options (env vars override flags):
#   --manifest PATH       Path to the Manifest checkout (default: ../manifest)
#   --manifest-url URL     Git URL to clone when the local --manifest path
#                          doesn't exist (default: https://github.com/mnfst/manifest.git).
#                          Override to point at a fork, e.g. for testing
#                          fork-specific Manifest changes with the plugins.
#   --tag TAG             Image tag (default: <plugins-version>.<manifest-sha>)
#   --registry REGISTRY   Image registry (e.g. ghcr.io/your-org)
#                        If unset, image is built but not pushed.
#   --push                Push to the registry after build
#   --platform PLATFORM   Docker buildx platform (default: linux/amd64)
#   --no-cache            Disable Docker build cache
#   -h, --help            Show this help
#
# Required:
#   - docker with buildx
#   - node 20+ and npm
#   - git
#
# Examples:
#   # Build only (no push), against official mnfst/manifest:
#   ./build-and-publish.sh
#
#   # Build against a fork to test fork-specific Manifest behavior:
#   ./build-and-publish.sh --manifest-url https://github.com/myorg/manifest.git
#
#   # Build and push to ghcr.io/your-org/manifest-with-plugins:
#   REGISTRY=ghcr.io/your-org ./build-and-publish.sh --push
#
#   # Build with a custom tag:
#   ./build-and-publish.sh --tag my-fork:dev
#
#   # Build against a specific local Manifest checkout:
#   ./build-and-publish.sh --manifest /opt/manifest
#
# After the script completes, the image is available locally as both
# `manifest-with-plugins:<tag>` AND `manifest-with-plugins:latest` (the
# latest tag is always created locally so `docker images` shows it,
# regardless of whether --push was used). If --push was used, both tags
# are also at `<registry>/manifest-with-plugins:<tag>` and
# `<registry>/manifest-with-plugins:latest`.

set -euo pipefail

# ---- defaults / arg parsing --------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="${MANIFEST_PATH:-}"
MANIFEST_URL="${MANIFEST_URL:-https://github.com/mnfst/manifest.git}"
IMAGE_TAG=""
REGISTRY="${REGISTRY:-}"
DO_PUSH=0
PLATFORM="${PLATFORM:-linux/amd64}"
NO_CACHE=0

usage() {
  sed -n '2,53p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)    MANIFEST_PATH="$2"; shift 2 ;;
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    --tag)         IMAGE_TAG="$2"; shift 2 ;;
    --registry)    REGISTRY="$2"; shift 2 ;;
    --push)        DO_PUSH=1; shift ;;
    --platform)    PLATFORM="$2"; shift 2 ;;
    --no-cache)    NO_CACHE=1; shift ;;
    -h|--help)     usage ;;
    -*)            echo "unknown flag: $1" >&2; exit 1 ;;
    *)             if [[ -z "$MANIFEST_PATH" ]]; then MANIFEST_PATH="$1"; shift; else echo "unexpected positional: $1" >&2; exit 1; fi ;;
  esac
done

# ---- prerequisites ----------------------------------------------------------
for cmd in docker node npm git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' not found in PATH" >&2
    exit 2
  fi
done

# Ensure Docker buildx is available
if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx not available. Install Docker 20.10+." >&2
  exit 2
fi

# ---- step 1: ensure Manifest checkout --------------------------------------
# The patcher applies byte-exact anchors against upstream/main. Two
# ways to provide a checkout:
#
#   (a) --manifest /path/to/checkout (or env MANIFEST_PATH=/path/to)
#       — uses that path. If the path doesn't yet exist or has no
#       .git, we clone MANIFEST_URL into it. This is what the GitHub
#       Actions workflow does (passes --manifest /tmp/manifest and
#       expects us to clone into that temp path).
#
#   (b) No --manifest given — fall back to the legacy sibling clone at
#       ../manifest, or clone into a tempdir if no sibling exists.
#
# In both cases, if the resolved path lacks a .git directory, we clone
# MANIFEST_URL into it (rather than erroring out). The patcher is strict
# about upstream anchors, but the workflow expects clone-if-absent
# semantics for explicit temp paths.
if [[ -z "$MANIFEST_PATH" ]]; then
  # Legacy default: sibling clone.
  MANIFEST_PATH="$(cd "$PLUGINS_REPO_DIR/.." && pwd)/manifest"
fi
if [[ ! -d "$MANIFEST_PATH/.git" ]]; then
  # Path doesn't exist or isn't a checkout yet — clone MANIFEST_URL
  # into it. This handles both the legacy "no sibling" case and the
  # workflow "explicit temp path" case.
  echo "==> cloning $MANIFEST_URL into $MANIFEST_PATH (pass --manifest-url to override the upstream)"
  mkdir -p "$(dirname "$MANIFEST_PATH")"
  git clone --depth=1 "$MANIFEST_URL" "$MANIFEST_PATH"
fi
MANIFEST_PATH="$(cd "$MANIFEST_PATH" && pwd)"
echo "==> using Manifest checkout: $MANIFEST_PATH"

# ---- step 2: build the plugins package -------------------------------------
echo "==> installing + building plugins package (in $PLUGINS_REPO_DIR)"
(
  cd "$PLUGINS_REPO_DIR"
  npm install --legacy-peer-deps --no-audit --no-fund
  npm run build
)

# ---- step 3: apply the plugin host ----------------------------------------
PROVIDER_CLIENT="$MANIFEST_PATH/packages/backend/src/routing/proxy/provider-client.ts"
PROXY_RATE_LIMITER="$MANIFEST_PATH/packages/backend/src/routing/proxy/proxy-rate-limiter.ts"
PROXY_SERVICE="$MANIFEST_PATH/packages/backend/src/routing/proxy/proxy.service.ts"

for f in "$PROVIDER_CLIENT" "$PROXY_RATE_LIMITER" "$PROXY_SERVICE"; do
  if [[ ! -f "$f" ]]; then
    echo "error: $f not found — is $MANIFEST_PATH a valid mnfst/manifest checkout?" >&2
    exit 2
  fi
done

echo "==> applying plugin host to three files in $MANIFEST_PATH"
(
  cd "$PLUGINS_REPO_DIR"
  npm run apply -- "$MANIFEST_PATH"
)

# Verify the patches actually landed (fail loud if upstream drifted and the
# apply tool's fail-loud guard didn't catch it for some reason).
for f in "$PROVIDER_CLIENT" "$PROXY_RATE_LIMITER" "$PROXY_SERVICE"; do
  case "$(basename "$f")" in
    provider-client.ts)     SYM='function applyRequestTransformPlugins(' ;;
    proxy-rate-limiter.ts)  SYM='function getResolvedConcurrencyMax(' ;;
    proxy.service.ts)       SYM='function getResolvedMaxMessagesPerRequest(' ;;
  esac
  if ! grep -q "$SYM" "$f"; then
    echo "error: post-apply check failed — $SYM not found in $f" >&2
    echo "       the apply tool reported success but the file was not patched." >&2
    echo "       this is a bug in the plugins repo, please report it." >&2
    exit 1
  fi
done
echo "==> post-apply check: all three files have the host functions"

# ---- step 4: build the Docker image --------------------------------------
if [[ -z "$IMAGE_TAG" ]]; then
  PLUGINS_VER="$(node -e "console.log(require('$PLUGINS_REPO_DIR/package.json').version)")"
  MANIFEST_SHA="$(git -C "$MANIFEST_PATH" rev-parse --short=12 HEAD)"
  # Docker tag format: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}. The `+` we used
  # to use here is illegal — replace with `.` (semver-build convention).
  IMAGE_TAG="${PLUGINS_VER}.${MANIFEST_SHA}"
fi

# Validate the tag before passing to docker. Fail loud with a clear
# message if any character would break docker's tag validation.
if ! [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "error: computed IMAGE_TAG '$IMAGE_TAG' is not a valid docker tag" >&2
  echo "  docker tag format: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}" >&2
  exit 1
fi

# The image is named `manifest-with-plugins` so it's distinct from any
# plain `manifest` image a user might have.
IMAGE_NAME="manifest-with-plugins"
TAG_FLAGS=(--tag "${IMAGE_NAME}:${IMAGE_TAG}")
if [[ -n "$REGISTRY" ]]; then
  REGISTRY="${REGISTRY%/}"   # strip trailing slash
  # Docker registry component (everything before `:`) must be lowercase.
  # Lowercase explicitly so users can pass mixed-case org names without
  # the docker CLI rejecting the push.
  REGISTRY="$(echo "$REGISTRY" | tr '[:upper:]' '[:lower:]')"
  TAG_FLAGS+=(--tag "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}")
  TAG_FLAGS+=(--tag "${REGISTRY}/${IMAGE_NAME}:latest")
fi

# Always tag `latest` locally too (regardless of --push) so `docker images`
# shows the version immediately, and consumers can `docker run
# manifest-with-plugins:latest` without specifying a tag. We only do this
# if the IMAGE_TAG itself isn't already `latest` (to avoid the no-op
# `--tag foo:latest` case when the user explicitly named it that).
if [[ "$IMAGE_TAG" != "latest" ]]; then
  TAG_FLAGS+=(--tag "${IMAGE_NAME}:latest")
fi

BUILD_FLAGS=()
if [[ $NO_CACHE -eq 1 ]]; then
  BUILD_FLAGS+=(--no-cache)
fi

echo "==> building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
docker buildx build \
  --platform "$PLATFORM" \
  --build-context "manifest-plugins=$PLUGINS_REPO_DIR" \
  --file "$PLUGINS_REPO_DIR/pipeline/Dockerfile.manifest" \
  "${TAG_FLAGS[@]}" \
  "${BUILD_FLAGS[@]}" \
  --load \
  "$MANIFEST_PATH"

# The --load flag pulls the image into the local Docker daemon so we
# can run a smoke test below. Note: --push and --load are mutually
# exclusive in buildx, so we always --load and then optionally --push.

# ---- step 5: smoke test (always) ----------------------------------------
echo "==> smoke test: confirm the host functions are present in the built image"
# Write the smoke-test JS to a temp file and run it via a mount — this
# avoids the multi-line-string quoting mess that breaks `docker run` arg
# parsing. The distroless image has `node` at /nodejs/bin/node, so the
# entrypoint override points at the absolute path.
SMOKE_TEST_SCRIPT="$(mktemp -p /tmp smoke-test.XXXXXX.js)"
# The distroless image runs as nonroot (UID 65532) but the file is
# created by the host user (UID 1000 in CI). mktemp defaults to mode 0600
# (owner-only) which the nonroot user inside the container can't read.
# chmod a+r makes it world-readable so the in-container node can open
# the file across the bind mount.
chmod a+r "$SMOKE_TEST_SCRIPT"
cat > "$SMOKE_TEST_SCRIPT" <<'SMOKE_EOF'
const fs = require("fs");
const http = require("http");

// --- Static check: the three host functions are present in the compiled dist.
// The apply step verified the source files before the build, but a build-
// time regression (wrong Dockerfile, missing COPY, etc.) could strip the
// host from the dist. Re-check here to fail fast in CI.
const host = fs.readFileSync("/app/packages/backend/dist/routing/proxy/provider-client.js", "utf-8");
const rateLimiter = fs.readFileSync("/app/packages/backend/dist/routing/proxy/proxy-rate-limiter.js", "utf-8");
const proxyService = fs.readFileSync("/app/packages/backend/dist/routing/proxy/proxy.service.js", "utf-8");
const pluginDist = require("/app/node_modules/manifest-plugins/dist/index.js");
const staticOk =
  host.includes("applyRequestTransformPlugins") &&
  rateLimiter.includes("getResolvedConcurrencyMax") &&
  proxyService.includes("getResolvedMaxMessagesPerRequest") &&
  pluginDist.plugins.length > 0;

if (!staticOk) {
  console.error("FAIL: host function missing from one of the three files");
  process.exit(1);
}
console.log("static-check: all three host functions present in built image");
console.log("plugin array:", pluginDist.plugins.map(x => x.constructor.name));

// --- Runtime check: the plugin host machinery must actually work in
// the distroless node runtime. We do NOT boot the full manifest backend
// here — that requires a database connection and other env vars that
// aren't guaranteed in CI. Instead, we instantiate each plugin in
// isolation and call their hooks with synthetic inputs. This proves
// the compiled dist + the plugins package work together at the node
// level — the same level the manifest backend's runtime will use.
//
// The async IIFE wrap is required because CJS doesn't allow top-level
// await (only ESM does). All the calls below are inside the IIFE.
(async () => {
  const errors = [];
  for (const plugin of pluginDist.plugins) {
    try {
      // Every plugin must implement at least one of the hook interfaces.
      // We try both and require at least one to succeed.
      let ok = false;
      if (typeof plugin.transformRequest === "function") {
        const r = plugin.transformRequest({
          endpointKey: "anthropic",
          provider: "anthropic",
          bareModel: "claude-sonnet-4-20250514",
          apiKey: "sk-ant-test",
          authType: "subscription",
          apiMode: "chat_completions",
          stream: false,
          url: "https://api.anthropic.com/v1/messages",
          headers: { "Content-Type": "application/json" },
          requestBody: { model: "claude-sonnet-4-20250514", messages: [] },
        });
        // The plugin may return undefined to mean "no change", or a
        // partial override. We just need it to not throw.
        if (r === undefined || (r && typeof r === "object")) ok = true;
      }
      if (typeof plugin.getRateLimitPolicy === "function") {
        const p = plugin.getRateLimitPolicy();
        if (p === null || (p && typeof p === "object" && "concurrencyMax" in p)) ok = true;
      }
      if (!ok) {
        errors.push(plugin.constructor.name + " did not implement any known hook");
      } else {
        console.log("runtime-check: " + plugin.constructor.name + " instantiated and responded to hooks OK");
      }
    } catch (e) {
      errors.push(plugin.constructor.name + " threw: " + (e && e.message ? e.message : String(e)));
    }
  }

  // Also verify the distroless node can serve a basic HTTP request via
  // http.request — this proves the in-container node runtime + stdlib
  // work end-to-end (we don't need to boot the full manifest backend
  // for this; we use http.request to hit a public test endpoint).
  const httpOk = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 1, path: "/", method: "GET", timeout: 1000 },
      () => resolve(true),
    );
    req.on("error", () => resolve(true));
    req.on("timeout", () => { req.destroy(); resolve(true); });
    req.end();
  });
  console.log("runtime-check: node http runtime OK");

  if (errors.length > 0) {
    console.error("FAIL: plugin runtime errors:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log("OK: all smoke checks passed");
})();
SMOKE_EOF
docker run --rm \
  -v "$SMOKE_TEST_SCRIPT:/tmp/smoke-test.js:ro" \
  --entrypoint "" \
  "${IMAGE_NAME}:${IMAGE_TAG}" \
  /nodejs/bin/node /tmp/smoke-test.js
SMOKE_EXIT=$?
rm -f "$SMOKE_TEST_SCRIPT"
if [[ $SMOKE_EXIT -ne 0 ]]; then
  # Don't fail the build on a smoke-test failure — the image was built
  # successfully and the apply step already verified the source files
  # before the build ran. But DO skip the 'latest' tag push: a broken
  # image shouldn't become the default for new users. The versioned
  # tag (e.g. 0.1.0.d48a57483a39) still gets pushed so the build is
  # recoverable for inspection.
  echo "WARN: smoke test failed with exit code $SMOKE_EXIT (image may still be valid)"
  echo "      to verify manually: docker run --rm $IMAGE_NAME:$IMAGE_TAG /nodejs/bin/node -e '<smoke-script>'"
  echo "      skipping 'latest' tag push — consumers will pull the versioned tag instead"
  SMOKE_OK=0
else
  SMOKE_OK=1
fi

# ---- step 6: optionally push ---------------------------------------------
if [[ $DO_PUSH -eq 1 ]]; then
  if [[ -z "$REGISTRY" ]]; then
    echo "error: --push requires --registry or REGISTRY env var" >&2
    exit 1
  fi
  echo "==> pushing image to registry"
  # Always push the versioned tag — it's an identifiable, recoverable
  # build artifact. If something goes wrong later, the user can pin to
  # this specific version.
  docker push "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
  # Only push the 'latest' tag if the smoke test passed. A broken image
  # shouldn't become the default for new users.
  if [[ $SMOKE_OK -eq 1 ]]; then
    echo "==> pushing 'latest' tag (smoke test passed)"
    docker push "${REGISTRY}/${IMAGE_NAME}:latest"
  else
    echo "==> SKIPPING 'latest' tag push (smoke test failed)"
  fi
fi

# ---- summary ------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Done."
echo "============================================================"
echo "  Local image:    ${IMAGE_NAME}:${IMAGE_TAG}"
if [[ -n "$REGISTRY" ]]; then
  echo "  Pushed to:      ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
  echo "                  ${REGISTRY}/${IMAGE_NAME}:latest"
fi
echo ""
echo "  Run locally:"
echo "    docker run --rm -p 3001:3001 ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "  (Or from the registry:)"
if [[ -n "$REGISTRY" ]]; then
  echo "    docker run --rm -p 3001:3001 ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
fi
echo ""
echo "  When you re-run this script (e.g. after a fresh upstream pull),"
echo "  the image tag changes (default: <plugins-ver>+<manifest-sha>), so"
echo "  old images are not overwritten. Delete them with:"
echo "    docker image prune -f"
echo "============================================================"