#!/usr/bin/env bash
# Builds edid-decode from a pinned v4l-utils commit, for tests and CI
# (SPEC.md section 8: the independent second opinion). edid-decode is MIT
# licensed; it is run as a separate process, never bundled.
#
# Usage: scripts/build-edid-decode.sh [output-dir]   (default .cache/edid-decode)
set -euo pipefail

COMMIT=c6600a7e342ef6e336fba02212c90b60a36ca02d
OUT=${1:-.cache/edid-decode}
BIN="$OUT/edid-decode"

if [[ -x "$BIN" && "$(cat "$OUT/COMMIT" 2>/dev/null)" == "$COMMIT" ]]; then
  echo "$BIN (cached, $COMMIT)"
  exit 0
fi

SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
git -C "$SRC" init -q
git -C "$SRC" remote add origin https://git.linuxtv.org/v4l-utils.git
git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
git -C "$SRC" checkout -q FETCH_HEAD -- utils/edid-decode

mkdir -p "$OUT"
cd "$SRC/utils/edid-decode"
sources=()
for f in *.cpp; do [[ "$f" == ddc.cpp ]] || sources+=("$f"); done
g++ -O1 -std=gnu++17 -DPACKAGE_VERSION="\"$COMMIT\"" -o "$OLDPWD/$BIN" "${sources[@]}"
echo "$COMMIT" > "$OLDPWD/$OUT/COMMIT"
echo "$BIN"
