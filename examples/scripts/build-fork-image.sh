#!/usr/bin/env bash
# build-fork-image.sh
# ===================
#
# Local end-to-end pipeline that:
#   1. Clones (or refreshes) manifest-plugins
#   2. Builds the plugins package
#   3. Applies the plugin host to a Manifest checkout
#   4. Builds a Docker image with the plugins context
#   5. Optionally tags and pushes the image
#
# Usage:
#   ./build-fork-image.sh [--manifest PATH] [--plugins PATH] [--tag TAG]
#                         [--registry REGISTRY/image] [--push]
#
# Defaults (override via env vars or flags):
#   MANIFEST_DIR     = ../manifest          (sibling clone)
#   PLUGINS_DIR      = ../manifest-plugins  (sibling clone)
#   IMAGE_TAG        = manifest:dev
#   REGISTRY         = (unset — don't tag for a registry)
#
# Exit codes:
#   0 = success, image built and (optionally) pushed
#   1 = generic failure (see stderr)
#   2 = prerequisites missing (git, docker, npm)

set -euo pipefail

# ---- defaults / arg parsing --------------------------------------------------
MANIFEST_DIR="${MANIFEST_DIR:-../manifest}"
PLUGINS_DIR="${PLUGINS_DIR:-../manifest-plugins}"
IMAGE_TAG="${IMAGE_TAG:-manifest:dev}"
REGISTRY="${REGISTRY:-}"
DO_PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)  MANIFEST_DIR="$2"; shift 2 ;;
    --plugins)   PLUGINS_DIR="$2"; shift 2 ;;
    --tag)       IMAGE_TAG="$2"; shift 2 ;;
    --registry)  REGISTRY="$2"; shift 2 ;;
    --push)      DO_PUSH=1; shift ;;
    -h|--help)   sed -n '3,20p' "$0"; exit 0 ;;
    *)           echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ---- prerequisites ----------------------------------------------------------
for cmd in git docker npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' not found in PATH" >&2
    exit 2
  fi
done

# ---- step 1: ensure plugins repo exists and is built ----------------------
if [[ ! -d "$PLUGINS_DIR/.git" ]]; then
  echo "==> cloning manifest-plugins into $PLUGINS_DIR"
  git clone --depth=1 https://github.com/JosiahSiegel/manifest-plugins.git "$PLUGINS_DIR"
fi

echo "==> installing + building plugins package"
(
  cd "$PLUGINS_DIR"
  npm install --legacy-peer-deps --no-audit --no-fund
  npm run build
)

# ---- step 2: ensure manifest repo exists ---------------------------------
if [[ ! -d "$MANIFEST_DIR/.git" ]]; then
  echo "==> cloning mnfst/manifest into $MANIFEST_DIR"
  git clone --depth=1 https://github.com/mnfst/manifest.git "$MANIFEST_DIR"
fi

# ---- step 3: apply the plugin host ----------------------------------------
PROVIDER_CLIENT="$MANIFEST_DIR/packages/backend/src/routing/proxy/provider-client.ts"
if [[ ! -f "$PROVIDER_CLIENT" ]]; then
  echo "error: provider-client.ts not found at $PROVIDER_CLIENT" >&2
  echo "       pass --manifest to point at a valid Manifest checkout" >&2
  exit 1
fi

echo "==> applying plugin host to $PROVIDER_CLIENT"
(
  cd "$PLUGINS_DIR"
  npm run apply -- "$(cd "$MANIFEST_DIR" && pwd)"
)

# ---- step 4: build the Docker image --------------------------------------
TAG_FLAGS=(--tag "$IMAGE_TAG")
if [[ -n "$REGISTRY" ]]; then
  TAG_FLAGS+=(--tag "${REGISTRY}:$(git -C "$MANIFEST_DIR" rev-parse --short HEAD)")
  TAG_FLAGS+=(--tag "${REGISTRY}:latest")
fi

echo "==> building Docker image: ${IMAGE_TAG}"
docker build \
  --build-context "manifest-plugins=$(cd "$PLUGINS_DIR" && pwd)" \
  "${TAG_FLAGS[@]}" \
  "$MANIFEST_DIR"

# ---- step 5: optionally push ---------------------------------------------
if [[ $DO_PUSH -eq 1 ]]; then
  if [[ -z "$REGISTRY" ]]; then
    echo "error: --push requires --registry" >&2
    exit 1
  fi
  echo "==> pushing image to registry"
  docker push "${REGISTRY}:$(git -C "$MANIFEST_DIR" rev-parse --short HEAD)"
  docker push "${REGISTRY}:latest"
fi

echo "==> done. image: ${IMAGE_TAG}"
if [[ -n "$REGISTRY" ]]; then
  echo "    pushed: ${REGISTRY}:$(git -C "$MANIFEST_DIR" rev-parse --short HEAD), ${REGISTRY}:latest"
fi