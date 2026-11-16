#!/usr/bin/env bash
#
# deepcopysync.sh — sync a deepcopy folder into a working tree, deletions included,
# without touching anything git ignores.
#
# THE PROBLEM THIS SOLVES
# A plain `rsync -a --delete` would mirror the source exactly, which means deleting
# everything the source lacks. The deepcopy has no node_modules, no dist/, no .env,
# no .git — so a naive mirror wipes all of them out of the destination. But you do
# want deletions: a folder removed in the deepcopy should disappear here too.
#
# HOW IT WORKS
# rsync does not delete paths it was told to exclude (that needs --delete-excluded,
# which is never passed here). So excluding every ignored path both stops it being
# copied and protects it from deletion — one mechanism, both behaviours.
#
# The ignore list comes from `git ls-files`, not from handing .gitignore to rsync.
# Their pattern languages only look alike: gitignore has `!` negation, `**`, and
# per-directory files with anchoring rules rsync does not share. Asking git means
# git's own semantics decide — including nested .gitignore files, .git/info/exclude
# and the user's global ignore file.
#
# Usage:
#   deepcopysync.sh <deepcopy-dir> [dest-dir] [--apply]
#
#   Dry run by default; prints exactly what it would copy and delete.
#   Pass --apply to actually do it.

set -euo pipefail

APPLY=0
SRC=""
DEST=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *)
      if [ -z "$SRC" ]; then SRC="$1"
      elif [ -z "$DEST" ]; then DEST="$1"
      else die "too many arguments"; fi
      ;;
  esac
  shift
done

[ -n "$SRC" ] || usage 1
DEST="${DEST:-$PWD}"

[ -d "$SRC" ]  || die "source is not a directory: $SRC"
[ -d "$DEST" ] || die "destination is not a directory: $DEST"

# Resolve symlinks and relative paths so the containment checks below are honest.
SRC="$(cd "$SRC" && pwd -P)"
DEST="$(cd "$DEST" && pwd -P)"

[ "$SRC" != "$DEST" ] || die "source and destination are the same directory"

# Syncing a tree into its own ancestor (or vice versa) copies into itself forever.
case "$DEST/" in "$SRC"/*) die "destination is inside the source";; esac
case "$SRC/"  in "$DEST"/*) die "source is inside the destination";; esac

# A --delete run rooted at / or $HOME is not a mistake worth surviving.
case "$DEST" in
  "/"|"$HOME") die "refusing to sync onto $DEST" ;;
esac

git -C "$DEST" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "destination is not a git repository — there is no ignore list to honour,
       and running without one would delete node_modules, dist, .env and more"

EXCLUDES="$(mktemp)"
trap 'rm -f "$EXCLUDES"' EXIT

# `.git/` first and unconditionally. The deepcopy almost certainly has no .git, so
# without this line the very first --apply deletes the destination's entire history.
printf '/.git/\n' > "$EXCLUDES"

# The script protects itself. If it lives inside the destination and the deepcopy
# has no copy of it, a mirror would delete the tool mid-run — which it does happily,
# because rsync has already read it. Relative path only when it is actually inside.
SELF="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
case "$SELF" in
  "$DEST"/*) printf '/%s\n' "${SELF#"$DEST"/}" >> "$EXCLUDES" ;;
esac

# git prints paths relative to the directory it runs in, so running it in $DEST
# gives paths already relative to the rsync transfer root. Leading "/" anchors each
# one where it actually is, rather than matching the same name at any depth.
#   --directory collapses a whole ignored tree to one entry, so node_modules/
#   contributes one line instead of fifty thousand.
( cd "$DEST" && git ls-files --others --ignored --exclude-standard --directory ) \
  | sed 's|^|/|' >> "$EXCLUDES"

IGNORED=$(( $(wc -l < "$EXCLUDES") - 1 ))

printf 'source      %s\n' "$SRC"
printf 'destination %s\n' "$DEST"
printf 'protected   %s ignored path(s) + .git/\n' "$IGNORED"
printf 'compare     checksum (content only; mtime and permission differences ignored)\n'
printf 'mode        %s\n\n' "$([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry run (pass --apply to execute)')"

# CONTENT, NOT TIMESTAMPS
#
# `-c` compares checksums instead of size+mtime. That is not a tidiness preference,
# it is a correctness fix: with the default quick check, a file whose content changed
# but whose size AND mtime happen to match is silently skipped. Verified — a 4-byte
# file edited in place kept its stale content and rsync reported nothing at all.
#
# `-rlD` is `-a` minus `-t`, `-p`, `-g` and `-o`. Each is dropped for its own reason.
#
# NO -t. Otherwise rsync rewrites the mtime of files whose content already matches,
# producing `.f..t....` lines and touching files nothing changed in. Free to drop,
# because `-c` no longer needs mtime to decide, and build tools prefer an mtime that
# moves only when content does.
#
# NO -p, -g, -o. The two ends of this sync are DIFFERENT MACHINES, so their modes,
# UIDs and GIDs mean different things and syncing them is noise at best. `-g`/`-o`
# are no-ops anyway without root. `-p` is the harmful one: it flags every directory
# whose mode differs by umask (`.d...p.....`) and rewrites content-identical files'
# permissions for no reason. Measured, on identical content with differing modes:
#
#   with    -p :  .f...p... same.txt      <- pure noise
#   without -p :  (nothing)               <- correct
#
# Dropping it costs nothing, because rsync bases a NEW file's mode on the source
# anyway — verified: a 755 script arrives 755 without `-p`, so the executable bit,
# the only permission git tracks, still survives. Existing files keep their local
# mode instead of being churned.
#
# DO NOT ADD -E to get the executable bit back. On macOS this rsync is openrsync,
# where `-E` is Apple's `--extended-attributes`, NOT upstream's `--executability`.
# It writes AppleDouble `._*` sidecar files into the destination and errors while
# doing it. Verified — it is actively destructive here.
#
# `-O` stops directory mtimes being synced, which is where the `.d..t.... ./` noise
# came from.
#
# Trailing slash on the source is load-bearing: "src/" copies its *contents* into
# dest, "src" would create dest/src.
RSYNC_ARGS=(-rlD -c -O --delete --itemize-changes --exclude-from="$EXCLUDES" "$SRC/" "$DEST/")
[ "$APPLY" -eq 1 ] || RSYNC_ARGS=(--dry-run "${RSYNC_ARGS[@]}")

OUT="$(mktemp)"
trap 'rm -f "$EXCLUDES" "$OUT"' EXIT
rsync "${RSYNC_ARGS[@]}" > "$OUT" 2>&1 || { cat "$OUT" >&2; die "rsync failed"; }

# Two kinds of line are removed before anything is shown, because both describe
# things that do not happen:
#
#   ".f..T.... path"  a no-transfer entry whose only difference is the timestamp.
#                     With -t dropped, the mtime is not rewritten either — verified
#                     by stat before and after — so the line is pure noise.
#   duplicate deletes openrsync prints a deletion twice when the directory holding
#                     it survives, once when the whole directory goes.
#
# Anything with a real flag (>f, c, s, p, o, g) survives the filter untouched.
clean() {
  grep -vE '^\.[a-zA-Z][.]*[tT][.]*[[:space:]]' "$OUT" | awk '!/^\*deleting/ || !seen[$0]++'
}
clean

# openrsync prints a deletion TWICE when the directory containing it survives, and
# once when the whole directory is removed. Counting raw lines therefore reports up
# to double. Unique paths are what a human wants to know.
DELETES=$(clean | grep -c '^\*deleting' || true)
CHANGES=$(clean | grep -vc '^\*deleting' || true)
printf '\n%s: %s deletion(s), %s change(s)\n' \
  "$([ "$APPLY" -eq 1 ] && echo 'applied' || echo 'would apply')" "$DELETES" "$CHANGES"

if [ "$APPLY" -eq 0 ] && [ "$DELETES" -gt 0 ]; then
  printf '\nunique paths that would be deleted:\n'
  clean | grep '^\*deleting' | sed 's/^\*deleting //' | sed 's/^/  /'
  printf '\nNOTE: files TRACKED by git are not protected. The ignore list only covers\n'
  printf 'untracked-and-ignored paths, so a tracked file the deepcopy lacks is treated\n'
  printf 'as deleted upstream. Check the list above before --apply.\n'
fi
