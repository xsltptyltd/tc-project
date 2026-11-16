#!/usr/bin/env bash
#
# deepcopy.sh — snapshot a slim copy of the WHOLE codebase into deepcopy-<repo>-<bytes>b/.
#
# Like rootchanges.sh, but instead of only the working-tree changes it copies EVERY source file in the repo,
# preserving the repo-relative directory structure. "Source file" = tracked-by-git OR untracked-but-not-ignored,
# so anything in .gitignore (__pycache__, node_modules, .venv, .aws-sam, .terraform, .ipynb_checkpoints, …) is
# excluded for free. A second explicit junk filter (EXCLUDE_RE) is applied on top as a safety net in case a build
# artifact ever gets force-added. Runs from anywhere inside the repo. Previous snapshots are removed on each run.
#
# The output directory is named after the repository folder and the time of the run:
#
#   repo at ~/Documents/home/cw, run at 2026-08-26 09:22:31  ->  deepcopy-cw-2026-08-26_09-22-31/

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"   # repo-relative paths + copy from the top level
cd "$ROOT"

REPO_NAME="$(basename "$ROOT")"           # the parent folder, e.g. "cw" — varies per checkout
PREFIX="deepcopy-${REPO_NAME}"

# Belt-and-suspenders: drop these even if git happens to track them. Matches a path segment anywhere, or a suffix.
EXCLUDE_RE='(^|/)(__pycache__|node_modules|\.aws-sam|\.ipynb_checkpoints|\.terraform|\.?venv([.-][^/]*)?|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.git|\.idea)(/|$)|(\.pyc|\.pyo|\.DS_Store)$'

# Build into a temp dir first: the final name embeds the run time, which is set after the copy.
TMP=".${PREFIX}.tmp.$$"
trap 'rm -rf "$ROOT/$TMP"' EXIT           # never leave a half-built temp dir behind

# Clear previous snapshots. Matched narrowly so this can never touch deepcopy.sh itself.
for d in "$ROOT"/deepcopy "$ROOT"/"$PREFIX"-* "$ROOT"/.deepcopy-*.tmp.*; do
  [ -d "$d" ] || continue                 # also absorbs an unmatched glob, which is not a directory
  rm -rf "$d"
done

rm -rf "$TMP"
mkdir -p "$TMP"

# Output dirs produced by deepcopy.sh and rootchanges.sh. They are untracked and NOT gitignored, so without this
# guard `git ls-files --others` feeds a previous snapshot — or the other script's snapshot — straight back in.
# The patterns use a dash, so deepcopy.sh / rootchanges.sh themselves are never matched.
is_snapshot() {
  case "$1" in
    "$TMP"|"$TMP"/*) return 0 ;;
    deepcopy|deepcopy/*|deepcopy-*) return 0 ;;
    rootchanges|rootchanges/*|rootchanges-*) return 0 ;;
    .deepcopy-*|.rootchanges-*) return 0 ;;
  esac
  return 1
}

count=0
skipped=0
bytes=0
copy_one() {
  local f="$1"
  is_snapshot "$f" && return 0
  if [[ "$f" =~ $EXCLUDE_RE ]]; then skipped=$((skipped + 1)); return; fi
  [ -f "$f" ] || return 0                            # skip dirs / just-deleted paths without tripping `set -e`
  mkdir -p "$TMP/$(dirname "$f")"
  cp -p "$f" "$TMP/$f"
  count=$((count + 1))
  bytes=$((bytes + $(wc -c < "$f")))                 # wc -c is portable; macOS pads with spaces, arithmetic ignores them
}

# Both loops use process substitution rather than a pipe so count/skipped/bytes survive in this shell.
# 1) every tracked file (git already filters out .gitignore'd paths)
while IFS= read -r -d '' f; do copy_one "$f"; done < <(git ls-files -z)

# 2) untracked files that git isn't ignoring (new code not yet committed)
while IFS= read -r -d '' f; do copy_one "$f"; done < <(git ls-files --others --exclude-standard -z)

STAMP="$(date +%Y-%m-%d_%H-%M-%S)"

OUT="${PREFIX}-${STAMP}"
rm -rf "$OUT"
mv "$TMP" "$OUT"
trap - EXIT                               # temp dir is now the real output; don't delete it

echo "copied $count file(s), $bytes byte(s) into $ROOT/$OUT/  (skipped $skipped junk path(s))"
