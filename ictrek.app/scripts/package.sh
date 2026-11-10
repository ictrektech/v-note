#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
src="$app_dir/src"
dist="$app_dir/dist"
version="${PACKAGE_VERSION:-$(tr -d '[:space:]' < "$app_dir/VERSION")}"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid package version: $version" >&2
  exit 1
}

: "${VNOTE_AMD_IMAGE:?set VNOTE_AMD_IMAGE to the amd64 image reference}"
: "${VNOTE_ARM_IMAGE:?set VNOTE_ARM_IMAGE to the arm64 image reference}"

for image in "$VNOTE_AMD_IMAGE" "$VNOTE_ARM_IMAGE"; do
  [[ "$image" =~ ^[a-z0-9.-]+(:[0-9]+)?/.+:[^[:space:]]+$ ]] || {
    echo "image must be a full registry reference with a tag: $image" >&2
    exit 1
  }
done

stage="$dist/staging"
rm -rf "$stage"
mkdir -p "$stage"

render_version() {
  python3 - "$1" "$2" "$version" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
version = sys.argv[3]
target.write_text(source.read_text().replace("__APP_VERSION__", version))
PY
}

render_compose() {
  python3 - "$1" "$2" "$version" "$VNOTE_AMD_IMAGE" "$VNOTE_ARM_IMAGE" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
version, amd_image, arm_image = sys.argv[3:6]
text = source.read_text()
text = text.replace("__APP_VERSION__", version)
text = text.replace("${VNOTE_AMD_IMAGE}", amd_image)
text = text.replace("${VNOTE_ARM_IMAGE}", arm_image)
target.write_text(text)
PY
}

for file in manifest.yml configs.yml routers.yml README.zh-CN.md README.en.md; do
  render_version "$src/$file" "$stage/$file"
done
render_compose "$src/docker-compose.yml" "$stage/docker-compose.yml"
cp "$src/icon.png" "$stage/icon.png"

cat > "$stage/.env" <<EOF
VNOTE_AMD_IMAGE=$VNOTE_AMD_IMAGE
VNOTE_ARM_IMAGE=$VNOTE_ARM_IMAGE
EOF

if grep -R -n -E '__[A-Z0-9_]+__|\$\{VNOTE_(AMD|ARM)_IMAGE\}' "$stage"; then
  echo "unrendered template tokens remain in the package" >&2
  exit 1
fi

if ! grep -q '^  vos_default:$' "$stage/docker-compose.yml" \
  || ! grep -q 'external: true' "$stage/docker-compose.yml" \
  || ! grep -q 'v-note-backend' "$stage/docker-compose.yml"; then
  echo "docker-compose.yml is missing the VOS network contract" >&2
  exit 1
fi

if ! grep -q 'iframe-src: /app/com.ictrek.v-note/' "$stage/routers.yml" \
  || ! grep -q 'entry-point: true' "$stage/routers.yml" \
  || ! grep -q 'embed: true' "$stage/routers.yml"; then
  echo "routers.yml is missing the VOS page contract" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]+image: [a-z0-9.-]+(:[0-9]+)?/.+:[^[:space:]]+$' "$stage/docker-compose.yml"; then
  echo "docker-compose.yml does not contain full registry image references" >&2
  exit 1
fi

rm -f "$dist/app.tar.gz" "$dist/v_note_${version}_pull.tar"
COPYFILE_DISABLE=1 tar -C "$stage" -czf "$dist/app.tar.gz" \
  .env manifest.yml docker-compose.yml configs.yml routers.yml icon.png README.zh-CN.md README.en.md
COPYFILE_DISABLE=1 tar -C "$dist" -cf "$dist/v_note_${version}_pull.tar" app.tar.gz

echo "package: $dist/v_note_${version}_pull.tar"
