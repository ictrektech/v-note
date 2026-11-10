#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
version_file="$root/ictrek.app/VERSION"
part="${1:-patch}"
[[ $# -le 1 ]] || { echo "Usage: $0 [patch|minor|major]" >&2; exit 1; }
current="$(tr -d '[:space:]' < "$version_file")"

[[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid VERSION: $current" >&2
  exit 1
}

IFS=. read -r major minor patch <<< "$current"
case "$part" in
  patch) patch=$((patch + 1)) ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  major) major=$((major + 1)); minor=0; patch=0 ;;
  *) echo "Usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

version="${major}.${minor}.${patch}"
trigger="vos-v-note-v${version}"
public_tag="v${version}"

cd "$root"
[[ -z "$(git status --porcelain)" ]] || { echo "worktree is not clean" >&2; exit 1; }
branch="$(git symbolic-ref --quiet --short HEAD)" || { echo "release requires a branch" >&2; exit 1; }
for tag in "$trigger" "$public_tag"; do
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    echo "local tag exists: $tag" >&2; exit 1
  fi
done
remote_tags="$(git ls-remote --tags origin "refs/tags/$trigger" "refs/tags/$public_tag")" || {
  echo 'cannot check origin tags' >&2; exit 1
}
[[ -z "$remote_tags" ]] || { echo 'release tag already exists on origin' >&2; exit 1; }

printf '%s\n' "$version" > "$version_file"
git add ictrek.app/VERSION
git diff --cached --check
git commit -m "chore: release VOS v-note ${version}"
git tag "$trigger"
git push --atomic origin "$branch" "$trigger"
echo "Pushed ${trigger}"
