#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
profile=""
tag=""
push=false
sheet=""

usage() {
  echo "Usage: $0 --profile amd|arm --tag <registry/repository:tag> [--push --sheet <sheet>]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --push) push=true; shift ;;
    --sheet) sheet="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$profile" == "amd" || "$profile" == "arm" ]] || usage
[[ -n "$tag" ]] || usage
if [[ "$push" == true ]]; then
  case "$profile:$sheet" in
    amd:AMD_with_mxn100|arm:ARM_without_cuda) ;;
    *) echo 'Publishing requires the matching explicit CPU sheet' >&2; exit 1 ;;
  esac
fi

case "$profile" in
  amd) expected="x86_64" ;;
  arm) expected="aarch64" ;;
esac

actual="$(uname -m)"
if [[ "$actual" != "$expected" ]]; then
  echo "profile $profile requires $expected build host, found $actual" >&2
  exit 1
fi

commit="${VNOTE_BUILD_COMMIT:-$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)}"
source_state="${VNOTE_SOURCE_STATE:-unknown}"
[[ "$commit" =~ ^[0-9a-f]{40}$ && "$source_state" =~ ^(clean|dirty)$ ]] || {
  echo "Set VNOTE_BUILD_COMMIT to a full commit hash and VNOTE_SOURCE_STATE to clean or dirty." >&2
  exit 1
}
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker buildx build --load --provenance=false --sbom=false \
  --build-arg "BUN_IMAGE=${BUN_IMAGE:-oven/bun:1.3.14-alpine}" \
  --build-arg "ALPINE_MIRROR=${ALPINE_MIRROR:-dl-cdn.alpinelinux.org}" \
  --build-arg "EDGE_EVER_BUILD_ID=$commit" \
  --label "org.opencontainers.image.revision=$commit" \
  --label "com.ictrek.source-state=$source_state" \
  --build-arg "EDGE_EVER_BUILD_CREATED_AT=$created_at" \
  --build-arg "EDGE_EVER_BUILD_TRIGGER=manual" \
  --build-arg "EDGE_EVER_BUILD_METHOD=local_cli" \
  --build-arg "VITE_VOS=true" \
  --build-arg "VITE_VOS_BASE_PATH=/app/com.ictrek.v-note/" \
  --tag "$tag" \
  "$root"

if [[ "$push" == "true" ]]; then
  docker push "$tag"
  repository="${tag%:*}"
  image_tag="${tag##*:}"
  python3 "$root/ictrek.app/scripts/feishu_release.py" --sheet "$sheet" --component v-note --tag "$image_tag" --repository "$repository"
fi
