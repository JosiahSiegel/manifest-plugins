#!/usr/bin/env bash
# build-and-publish.sh
# =====================
#
# End-to-end pipeline that:
#   1. Clones a fresh mnfst/manifest checkout (or uses --manifest PATH).
#   2. Builds the manifest-plugins package (this repo) so the apply
#      CLI and the runtime dist/ are available.
#   3. Applies the plugin host to all three target files in the
#      Manifest checkout (provider-client.ts, proxy-rate-limiter.ts,
#      proxy.service.ts). Idempotent — safe to re-run.
#   4. Builds a Docker image with the plugins baked in, using
#      `manifest-plugins` as a named BuildKit build-context.
#   5. Runs the canonical e2e test: boot image + GET / must serve the
#      Manifest dashboard (not Nest's default 404).
#   6. Optionally pushes the versioned tag. Pushes `latest` only if
#      the e2e test passed.
#   7. Prints usage instructions for the resulting image.
#
# The user runs this script ONCE to publish an image; downstream
# consumers just `docker pull` and `docker run` — no apply step
# required on their end.
#
# Usage:
#   ./build-and-publish.sh [options] [manifest-checkout-path]
#
# Options (flags override env vars):
#   --manifest PATH       Path to a Manifest checkout. If omitted, the
#                         script clones a fresh shallow MANIFEST_URL copy.
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
# regardless of whether --push was used). If --push was used, the
# versioned tag is always pushed. The remote `latest` tag is pushed
# only after the e2e test passes.

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
# Default behavior is intentionally "fresh upstream clone", not "reuse
# ../manifest". A sibling checkout is often a fork or a local worktree
# with housekeeping overlays; byte-exact patch anchors can drift there.
#
# To use a specific checkout, pass --manifest PATH (or set MANIFEST_PATH).
# If that path doesn't exist yet, we clone MANIFEST_URL into it. This is
# what the GitHub Actions workflow does with --manifest /tmp/manifest.
#
# If no path is provided, clone a fresh shallow copy into a tempdir.
# That keeps the default pipeline deterministic and upstream-shaped.
if [[ -z "$MANIFEST_PATH" ]]; then
  MANIFEST_PATH="$(mktemp -d -t manifest-build-XXXXXX)/manifest"
  echo "==> cloning $MANIFEST_URL into $MANIFEST_PATH (fresh checkout; pass --manifest to reuse a local tree)"
  git clone --depth=1 "$MANIFEST_URL" "$MANIFEST_PATH"
elif [[ ! -d "$MANIFEST_PATH/.git" ]]; then
  echo "==> cloning $MANIFEST_URL into $MANIFEST_PATH (explicit --manifest path did not exist yet)"
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

# ---- step 5: e2e test (always) -------------------------------------------
# The canonical validation: boot the container against a scratch
# PostgreSQL, wait for the Nest backend to bind its port, and assert
# the dashboard actually serves at GET /. This catches every class of
# regression a symbol-check can't see:
#   - missing frontend dist in the runtime image (the 404 bug)
#   - broken serve-static config
#   - Vite asset-pipeline / hash mismatch
#   - port-binding / DNS / network-mode regressions
#
# The e2e test is a sibling script (pipeline/e2e-test.sh) so the same
# logic runs locally (`make e2e` or `bash pipeline/e2e-test.sh <tag>`)
# and in CI. The script returns non-zero on any failed assertion.
echo "==> e2e test: boot container, GET / must serve the dashboard"
E2E_OK=1
E2E_LOG="$(mktemp -t e2e-test.XXXXXX.log)"
if ! bash "$(dirname "$0")/e2e-test.sh" "${IMAGE_NAME}:${IMAGE_TAG}" >"$E2E_LOG" 2>&1; then
  E2E_OK=0
  echo "  FAIL — e2e test did not pass; see log below."
  echo "  --- e2e log (${E2E_LOG}) ---"
  sed 's/^/    /' "$E2E_LOG"
  echo "  --- end e2e log ---"
else
  # Echo the e2e output so the build log shows what passed.
  sed 's/^/    /' "$E2E_LOG"
fi
rm -f "$E2E_LOG"

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
  # Only push the 'latest' tag if the e2e test passed. A broken image
  # shouldn't become the default for new users. The versioned tag
  # (e.g. 0.1.0.d48a57483a39) still gets pushed so the build is
  # recoverable for inspection.
  if [[ $E2E_OK -eq 1 ]]; then
    echo "==> pushing 'latest' tag (e2e test passed)"
    docker push "${REGISTRY}/${IMAGE_NAME}:latest"
  else
    echo "==> SKIPPING 'latest' tag push (e2e test failed — see log above)"
    echo "    consumers will pull the versioned tag instead"
  fi
fi

if [[ $E2E_OK -ne 1 ]]; then
  echo "error: e2e test failed — not publishing latest and exiting non-zero" >&2
  exit 1
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
echo "    docker run --rm -p 2099:2099 \\"
echo "      -e DATABASE_URL=... -e BETTER_AUTH_SECRET=\$(openssl rand -hex 32) \\"
echo "      ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "  (Or from the registry:)"
if [[ -n "$REGISTRY" ]]; then
  echo "    docker run --rm -p 2099:2099 \\"
  echo "      -e DATABASE_URL=... -e BETTER_AUTH_SECRET=\$(openssl rand -hex 32) \\"
  echo "      ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
fi
echo ""
echo "  When you re-run this script (e.g. after a fresh upstream pull),"
echo "  the image tag changes (default: <plugins-ver>+<manifest-sha>), so"
echo "  old images are not overwritten. Delete them with:"
echo "    docker image prune -f"
echo "============================================================"