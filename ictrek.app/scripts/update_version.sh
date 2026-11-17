#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
version_file=ictrek.app/VERSION
version_tool=ictrek.app/scripts/release_version.py

case "${1:-}" in
  ''|--print|--print-package) [[ $# -le 1 ]] ;;
  *) echo "Usage: $0 [--print|--print-package]" >&2; exit 1 ;;
esac

upstream="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
current="$(tr -d '[:space:]' < "$version_file")"
remote_refs="$(git ls-remote --tags --refs origin 'refs/tags/v*.vos.*' 'refs/tags/vos-v-note-v*.vos.*')"
label="$(
  {
    git for-each-ref --format='%(refname)' refs/tags
    printf '%s\n' "$remote_refs"
  } | python3 "$version_tool" next "$upstream" "$current"
)"
version="$(python3 "$version_tool" package "$label")"
case "${1:-}" in
  --print) printf '%s\n' "$label"; exit 0 ;;
  --print-package) printf '%s\n' "$version"; exit 0 ;;
esac

[[ -z "$(git status --porcelain)" ]] || { echo "worktree is not clean" >&2; exit 1; }
branch="$(git symbolic-ref --quiet --short HEAD)" || { echo "release requires a branch" >&2; exit 1; }
trigger="vos-v-note-v${label}"
public_tag="v${label}"
for tag in "$trigger" "$public_tag"; do
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    echo "local tag exists: $tag" >&2; exit 1
  fi
done
[[ -z "$(git ls-remote --tags origin "refs/tags/$trigger" "refs/tags/$public_tag")" ]] || {
  echo 'release tag already exists on origin' >&2; exit 1
}
python3 - "$version" <<'PY'
import json
import sys

record = json.load(open('ictrek.app/release-images.json'))
if record.get('version') != sys.argv[1]:
    raise SystemExit('Build and verify both release images, then commit release-images.json for this package version')
PY

printf '%s\n' "$version" > "$version_file"
git add "$version_file"
git diff --cached --check
git commit -m "chore: release V-Note v${label}"
git tag "$trigger"
git push --atomic origin "$branch" "$trigger"
echo "Pushed ${trigger} (VOS package ${version})"
