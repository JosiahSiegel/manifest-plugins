#!/usr/bin/env bash
# build-and-publish.sh
# =====================
#
# End-to-end pipeline that:
#   1. Clones a fresh mnfst/manifest checkout (or uses --manifest PATH
#      / --manifest-dir PATH).
#   2. Builds the manifest-plugins package (this repo) so the apply
#      CLI and the runtime dist/ are available.
#   3. Applies the plugin host to all four target files in the
#      Manifest checkout (provider-client.ts, proxy-rate-limiter.ts,
#      proxy.service.ts). Idempotent — safe to re-run.
#   4. Builds a Docker image with the plugins baked in, using
#      `manifest-plugins` as a named BuildKit build-context.
#   5. Captures the immutable image digest of the build, re-tags a
#      copy as e2e:<digest-suffix> so the e2e script sees a stable
#      ref, and runs the canonical e2e test: boot image + GET / must
#      serve the Manifest dashboard (not Nest's default 404).
#   6. Only promotes `latest` after the e2e test passes for that
#      captured digest. The remote `:latest` is gated on this digest
#      passing, never on a stale local one.
#   7. Optionally pushes the versioned tag (always) + the `latest`
#      tag (only after digest-pinned e2e success) to a registry.
#   8. Prints usage instructions for the resulting image.
#
# The user runs this script ONCE to publish an image; downstream
# consumers just `docker pull` and `docker run` — no apply step
# required on their end.
#
# Usage:
#   ./build-and-publish.sh [options] [manifest-checkout-path]
#
# Options (flags override env vars):
#   --manifest PATH        Path to a Manifest checkout. Deprecated alias
#                          for --manifest-dir. Clones MANIFEST_URL into
#                          the path if it doesn't yet exist.
#   --manifest-dir PATH    Path to a local Manifest checkout. Same as
#                          --manifest. Captures git HEAD or a content
#                          digest as SOURCE_COMMIT.
#   --manifest-url URL     Git URL to clone when no local checkout is
#                          provided. Default: https://github.com/mnfst/manifest.git.
#   --manifest-ref REF     Ref/branch/SHA to pin the clone to. When set,
#                          SOURCE_COMMIT is captured after clone.
#   --manifest-fork OWNER/REPO
#                          Resolves to https://github.com/<owner>/<repo>.git
#                          and clones that fork instead.
#   --mvp                  Publish MVP UI mode. Requires an explicit
#                          --manifest-url / --manifest-ref /
#                          --manifest-fork / --manifest-dir so the
#                          build is traceable. Refuses the implicit
#                          official clone (which would silently publish
#                          MVP UI against whatever upstream HEAD happens
#                          to be).
#   --apply-overlay        Rebuild the overlay package via
#                          `npm run build:overlay` before invoking the
#                          apply CLI. The normal apply path already
#                          forwards the CLI's `--apply-overlay` mode so
#                          the routing-override host hook is installed
#                          by default. When the apply step reports
#                          drift, the pipeline exits non-zero.
#   --tag TAG              Image tag (default: <plugins-version>.<manifest-sha>)
#   --registry REGISTRY    Image registry (e.g. ghcr.io/your-org)
#                          If unset, image is built but not pushed.
#   --push                 Push to the registry after build
#   --platform PLATFORM    Docker buildx platform (default: linux/amd64)
#   --no-cache             Disable Docker build cache
#   -h, --help             Show this help
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
#   # MVP build (requires explicit source):
#   ./build-and-publish.sh --mvp --manifest-fork myorg/manifest --manifest-ref mvp-ui
#
#   # Build and push to ghcr.io/your-org/manifest-with-plugins:
#   REGISTRY=ghcr.io/your-org ./build-and-publish.sh --push
#
#   # Build with a custom tag:
#   ./build-and-publish.sh --tag my-fork:dev
#
#   # Build against a specific local Manifest checkout:
#   ./build-and-publish.sh --manifest-dir /opt/manifest
#
# After the script completes, the image is available locally as both
# `manifest-with-plugins:<tag>` AND `manifest-with-plugins:latest` (the
# latest tag is always created locally so `docker images` shows it,
# regardless of whether --push was used). If --push was used, the
# versioned tag is always pushed. The remote `latest` tag is pushed
# only after the e2e test passed for the captured digest.

set -euo pipefail

# ---- defaults / arg parsing --------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="${MANIFEST_PATH:-}"
MANIFEST_URL="${MANIFEST_URL:-https://github.com/mnfst/manifest.git}"
MANIFEST_REF="${MANIFEST_REF:-}"
MANIFEST_FORK="${MANIFEST_FORK:-}"
IMAGE_TAG=""
REGISTRY="${REGISTRY:-}"
DO_PUSH=0
PLATFORM="${PLATFORM:-linux/amd64}"
NO_CACHE=0
MVP=0
APPLY_MVP_OVERLAY=0

usage() {
  sed -n '2,70p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)       MANIFEST_PATH="$2"; shift 2 ;;
    --manifest-dir)   MANIFEST_PATH="$2"; shift 2 ;;
    --manifest-url)   MANIFEST_URL="$2"; shift 2 ;;
    --manifest-ref)   MANIFEST_REF="$2"; shift 2 ;;
    --manifest-fork)
      value="$2"
      shift 2
      if [[ "$value" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
        MANIFEST_FORK="$value"
        MANIFEST_URL="https://github.com/${value}.git"
      else
        echo "error: --manifest-fork must look like <owner>/<repo>; got '$value'" >&2
        exit 1
      fi
      ;;
    --mvp)            MVP=1; shift ;;
    --apply-overlay)  APPLY_MVP_OVERLAY=1; shift ;;
    --tag)            IMAGE_TAG="$2"; shift 2 ;;
    --registry)       REGISTRY="$2"; shift 2 ;;
    --push)           DO_PUSH=1; shift ;;
    --platform)       PLATFORM="$2"; shift 2 ;;
    --no-cache)       NO_CACHE=1; shift ;;
    -h|--help)        usage ;;
    -*)               echo "unknown flag: $1" >&2; exit 1 ;;
    *)                if [[ -z "$MANIFEST_PATH" ]]; then MANIFEST_PATH="$1"; shift; else echo "unexpected positional: $1" >&2; exit 1; fi ;;
  esac
done

# ---- MVP guard: refuse to publish MVP UI against the implicit official clone -
# If --mvp / MVP_UI=1 is set and the user did NOT pass an explicit source
# override (manifest-ref / manifest-fork / manifest-dir), we abort. The
# default fresh-clone path is fine for the canonical manifest-with-plugins
# image, but an MVP build needs traceability — the image tag alone is
# not enough to identify what was published.
if [[ $MVP -eq 1 ]] && [[ -z "$MANIFEST_REF" ]] && [[ -z "$MANIFEST_FORK" ]] && [[ -z "$MANIFEST_PATH" ]]; then
  echo "error: --mvp / MVP_UI=1 requires an explicit Manifest source." >&2
  echo "  Pass one of:" >&2
  echo "    --manifest-dir PATH           local checkout (git HEAD or content digest)" >&2
  echo "    --manifest-url URL            non-official clone URL" >&2
  echo "    --manifest-ref REF            pin the official clone to a ref/SHA" >&2
  echo "    --manifest-fork OWNER/REPO    use a fork" >&2
  echo "  The default implicit official clone is too implicit for an MVP build." >&2
  exit 2
fi

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
# To use a specific checkout, pass --manifest-dir PATH (or set
# MANIFEST_PATH). If that path doesn't exist yet, we clone MANIFEST_URL
# into it. This is what the GitHub Actions workflow does with
# --manifest /tmp/manifest.
#
# If no path is provided, clone a fresh shallow copy into a tempdir.
# That keeps the default pipeline deterministic and upstream-shaped.
SOURCE_COMMIT=""
if [[ -z "$MANIFEST_PATH" ]]; then
  MANIFEST_PATH="$(mktemp -d -t manifest-build-XXXXXX)/manifest"
  echo "==> cloning $MANIFEST_URL into $MANIFEST_PATH (fresh checkout; pass --manifest-dir to reuse a local tree)"
  if [[ -n "$MANIFEST_REF" ]]; then
    git clone --depth=1 --branch "$MANIFEST_REF" "$MANIFEST_URL" "$MANIFEST_PATH"
  else
    git clone --depth=1 "$MANIFEST_URL" "$MANIFEST_PATH"
  fi
elif [[ ! -d "$MANIFEST_PATH/.git" ]]; then
  echo "==> cloning $MANIFEST_URL into $MANIFEST_PATH (explicit --manifest-dir path did not exist yet)"
  mkdir -p "$(dirname "$MANIFEST_PATH")"
  if [[ -n "$MANIFEST_REF" ]]; then
    git clone --depth=1 --branch "$MANIFEST_REF" "$MANIFEST_URL" "$MANIFEST_PATH"
  else
    git clone --depth=1 "$MANIFEST_URL" "$MANIFEST_PATH"
  fi
fi
MANIFEST_PATH="$(cd "$MANIFEST_PATH" && pwd)"
echo "==> using Manifest checkout: $MANIFEST_PATH"

# Capture SOURCE_COMMIT for traceability. This is what gets written
# to the apply step's .manifest-source-commit and what the image tag
# will encode. A pinned ref still resolves to a real commit via HEAD.
SOURCE_COMMIT="$(git -C "$MANIFEST_PATH" rev-parse HEAD)"
echo "==> SOURCE_COMMIT=${SOURCE_COMMIT}"

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

echo "==> applying plugin host to four files in $MANIFEST_PATH"
echo "[manifest-plugins/apply] SOURCE_COMMIT=${SOURCE_COMMIT}"
(
  cd "$PLUGINS_REPO_DIR"
  # Pass MVP=1 through so the CLI guard activates for the same condition.
  # The default image build always forwards --apply-overlay so the
  # four-overlay installer applies the routing-override host hook.
  if [[ $APPLY_MVP_OVERLAY -eq 1 ]]; then
    npm run build:overlay
  fi
  if [[ $MVP -eq 1 ]]; then
    MVP_UI=1 npm run apply -- --apply-overlay "$MANIFEST_PATH"
  else
    npm run apply -- --apply-overlay "$MANIFEST_PATH"
  fi
)

# Verify the patches actually landed (fail loud if upstream drifted and the
# apply tool's fail-loud guard didn't catch it for some reason).
for f in "$PROVIDER_CLIENT" "$PROXY_RATE_LIMITER"; do
  case "$(basename "$f")" in
    provider-client.ts)     SYM='function applyRequestTransformPlugins(' ;;
    proxy-rate-limiter.ts)  SYM='function getResolvedConcurrencyMax(' ;;
  esac
  if ! grep -q "$SYM" "$f"; then
    echo "error: post-apply check failed — $SYM not found in $f" >&2
    echo "       the apply tool reported success but the file was not patched." >&2
    echo "       this is a bug in the plugins repo, please report it." >&2
    exit 1
  fi
done
if ! grep -q 'function applyProxyRoutingOverridePlugins(' "$PROXY_SERVICE"; then
  echo "error: post-apply check failed — function applyProxyRoutingOverridePlugins( not found in $PROXY_SERVICE" >&2
  echo "       the default apply/build path did not install the routing-override hook." >&2
  exit 1
fi
echo "==> post-apply check: all host functions are installed"

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
# NOTE: we deliberately do NOT tag `latest` during buildx. `latest` is
# only ever assigned to a specific captured digest that has passed the
# e2e test (see step 5 → step 6 below). Building with --tag :latest
# is a footgun: it lets a never-e2e'd image inherit the tag.
TAG_FLAGS=(--tag "${IMAGE_NAME}:${IMAGE_TAG}")
if [[ -n "$REGISTRY" ]]; then
  REGISTRY="${REGISTRY%/}"   # strip trailing slash
  # Docker registry component (everything before `:`) must be lowercase.
  # Lowercase explicitly so users can pass mixed-case org names without
  # the docker CLI rejecting the push.
  REGISTRY="$(echo "$REGISTRY" | tr '[:upper:]' '[:lower:]')"
  TAG_FLAGS+=(--tag "${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}")
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

# ---- step 5: capture the immutable image digest ----------------------------
# The image digest is the only stable handle for "this exact build".
# Buildx --tag produces a mutable tag, but RepoDigests/Id is the
# content-addressed identifier that never changes for the same bytes.
E2E_IMAGE_DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "${IMAGE_NAME}:${IMAGE_TAG}" 2>/dev/null || true)"
if [[ -z "$E2E_IMAGE_DIGEST" ]]; then
  E2E_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "${IMAGE_NAME}:${IMAGE_TAG}")"
fi
echo "==> E2E_IMAGE_DIGEST=${E2E_IMAGE_DIGEST}"

# Re-tag a stable e2e:<digest-suffix> reference so the e2e script
# always operates on THIS captured build. We strip everything before
# the colon (sha256:, etc.) so the suffix is safe in a docker tag.
DIGEST_SUFFIX="${E2E_IMAGE_DIGEST##*:}"
# Trim long digests so the resulting tag stays inside docker's 128-char
# limit even when prepended with "e2e-".
E2E_IMAGE_TAG="e2e-${DIGEST_SUFFIX:0:40}"
docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${E2E_IMAGE_TAG}"
echo "==> retagged as ${IMAGE_NAME}:${E2E_IMAGE_TAG}"

# ---- step 6: e2e test (always, against the captured digest) ----------------
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
E2E_TAG_FOR_SCRIPT="${IMAGE_NAME}:${E2E_IMAGE_TAG}"
E2E_ENV=()
  E2E_ENV=(ADMIN_UI=1)
  if [[ $MVP -eq 1 ]]; then
    E2E_ENV+=(MVP_UI=1)
  fi
  if ! env "${E2E_ENV[@]}" bash "$(dirname "$0")/e2e-test.sh" "$E2E_TAG_FOR_SCRIPT" >"$E2E_LOG" 2>&1; then
  E2E_OK=0
  echo "  FAIL — e2e test did not pass for ${E2E_IMAGE_DIGEST}; see log below."
  echo "  --- e2e log (${E2E_LOG}) ---"
  sed 's/^/    /' "$E2E_LOG"
  echo "  --- end e2e log ---"
else
  # Echo the e2e output so the build log shows what passed.
  sed 's/^/    /' "$E2E_LOG"
fi
rm -f "$E2E_LOG"

# ---- step 7: promote `:latest` only after digest-pinned e2e passes --------
# `:latest` must always point at a captured digest that has actually
# passed the e2e test. We tag it AFTER the e2e test, and only when
# E2E_OK=1. This guarantees a broken image never silently becomes
# the default for downstream consumers.
if [[ $E2E_OK -eq 1 ]]; then
  echo "==> promoting ${IMAGE_NAME}:latest from ${E2E_IMAGE_DIGEST}"
  docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:latest"
  if [[ -n "$REGISTRY" ]]; then
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${REGISTRY}/${IMAGE_NAME}:latest"
  fi
  echo "[pipeline] latest promoted from ${E2E_IMAGE_DIGEST}"
fi

# ---- step 8: optionally push ---------------------------------------------
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
  # Only push the 'latest' tag if the e2e test passed for THIS
  # captured digest. A broken image shouldn't become the default for
  # new users. The versioned tag (e.g. 0.1.0.d48a57483a39) still gets
  # pushed so the build is recoverable for inspection.
  if [[ $E2E_OK -eq 1 ]]; then
    echo "==> pushing 'latest' tag (digest-pinned e2e passed for ${E2E_IMAGE_DIGEST})"
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
echo "  Source commit:   ${SOURCE_COMMIT}"
echo "  Local image:     ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  E2E ref:         ${IMAGE_NAME}:${E2E_IMAGE_TAG}"
echo "  E2E digest:      ${E2E_IMAGE_DIGEST}"
if [[ -n "$REGISTRY" ]]; then
  echo "  Pushed to:       ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
  if [[ $E2E_OK -eq 1 ]]; then
    echo "                   ${REGISTRY}/${IMAGE_NAME}:latest"
  fi
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