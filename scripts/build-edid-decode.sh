#!/usr/bin/env bash
# Builds edid-decode from a pinned v4l-utils commit, for tests and CI
# (SPEC.md section 8: the independent second opinion). edid-decode is MIT
# licensed; it is run as a separate process, never bundled.
#
# The source comes from git.linuxtv.org, or from the Software Heritage archive
# when linuxtv cannot serve it (its web front end now sits behind a bot check
# and git fetches break mid-stream, 2026-11-06). Either way every file must
# match the SHA-256 manifest below, so both sources build identical code.
# Changing COMMIT means regenerating the manifest from
# https://archive.softwareheritage.org/api/1/revision/$COMMIT/directory/utils/edid-decode/
#
# Usage: scripts/build-edid-decode.sh [output-dir]   (default .cache/edid-decode)
set -euo pipefail

COMMIT=c6600a7e342ef6e336fba02212c90b60a36ca02d
OUT=${1:-.cache/edid-decode}
BIN="$OUT/edid-decode"

# sha256, git blob id, file: every file the build uses (ddc.cpp, the Linux
# DDC reader, is left out).
MANIFEST='b7ffd10a74300aeedee96388da0954f717668bd39d3b00c8b46d3cf6f770f409 ae2ffcd2bbc8acf1e8a6345ef1c6d67bc6d24fb3 LICENSE
a32ef4cfbd3df689fa7cea6f5eaac2f9fcd86d09afa520ea9c68063b81215e58 ce6e15ae63f4d5956637ee9af0fda047a4c055a7 calc-gtf-cvt.cpp
75992e5efd148cf29b7ed3e31a4432415b7c21b02e3483a75addcfdaf88faa41 2528ac9457f7173a2b4ccc8091ca2115172bfe7f calc-ovt.cpp
f9f5470735adb1884066fbe9acea9eb821e5abaee497271949fd9737858f6914 94e80d18f23fcb8bb6c1110f9d943c4f7ae3ea47 edid-decode.cpp
2b7d7fdee5a584b6d18a62b3fa8dba9e4d40fcc92cc49cd9ce7da0704eadec70 a42266ffa51da92b5b1ca89231400e9355f25ec3 edid-decode.h
f4a4ecaae4f168075cef302868ce84c14aad5e132fa348665db7a45738863c28 f0ffd7d2628eb89092197fcefca1bf39dadf2d76 oui.h
e8b4310b65519b4ae30727bc0b5a86db698a1097b7371a8eaee5b0349f5226f1 27942a022195d7f9fa467a737cb495bd87293a25 parse-base-block.cpp
80fbf587cef0593fdd0e56212cbe4ad5ba1182d59b177b0734809af8b4dbf759 e083d968b077a3aa53deb9e0fcfca98a44396c17 parse-cta-block.cpp
87cc70bbf7f5f98da1558bf0c9d297eef04590c6babc5870cbf8bd9ce59b3747 28cfae8a01f5bf767edc06ef5dd93c055d59ff9c parse-di-ext-block.cpp
e77ca72a9df5727fcd2b4b9082b7a4ac92a696967b0e8f98c54ade0ada29858c 1013af92fe814cd0b22efa0a4fdb22e39dacf2f4 parse-displayid-block.cpp
b4b2c9d7bc60a7b031964d344a870998a5fa8ddcb079cdeb5cfba9ccb3a24d99 de3ea64d110b98d86406d85451272dcd18a4a4d0 parse-dualmode.cpp
1b15158e3c398c61478d5ffdb74b80861d462756082fd042be1e482e39c4df8d a569a278ef4f911b99de7ed2975dd038d40484a2 parse-eld.cpp
d2637574ab99a5d1e80e8131ea67f66cbdc52e9aadcf41aca7ec7b0eee5e277e ded77ea6c2cefcb1577e8629eedd6dec4d42d2f9 parse-hdcp.cpp
504a530c3c09fcf40b7c8ba678717df37429001d8bd88e0fcb5682a7397d2912 08951387afb991da289e0b66599b3df9f474a617 parse-if.cpp
74e93823e1f4b81c43e0417001e349a5e1f2988cdf56e6e20a54a4426a596171 990904738688835fc5d244a59875b3924fa8760e parse-ls-ext-block.cpp
c15de7a9d8cb9def428db908a036f96be1328d6f77bb14857806ca1e87c54f20 d27972ee7a0cd504fd781d285ea8b248753f7902 parse-scdc.cpp
d7f7f2a46c1c38760d57bf97a7a5e4f164b885fdf7cdc9527d5384ee7d925226 3183512ffb0d78f8efa064ace753b51bfda9485d parse-vtb-ext-block.cpp'

if [[ -x "$BIN" && "$(cat "$OUT/COMMIT" 2>/dev/null)" == "$COMMIT" ]]; then
  echo "$BIN (cached, $COMMIT)"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC="$TMP/edid-decode"
mkdir -p "$SRC"

from_linuxtv() {
  local repo="$TMP/v4l-utils" attempt
  git -C "$TMP" init -q v4l-utils
  git -C "$repo" remote add origin https://git.linuxtv.org/v4l-utils.git
  for attempt in 1 2 3; do
    if git -C "$repo" -c http.version=HTTP/1.1 fetch -q --depth 1 origin "$COMMIT"; then
      git -C "$repo" checkout -q FETCH_HEAD -- utils/edid-decode
      while read -r _ _ name; do cp "$repo/utils/edid-decode/$name" "$SRC/$name"; done <<< "$MANIFEST"
      return 0
    fi
    sleep $((attempt * 5))
  done
  return 1
}

from_software_heritage() {
  local blob name
  while read -r _ blob name; do
    curl -fsS --retry 4 --retry-delay 5 --max-time 120 -o "$SRC/$name" \
      "https://archive.softwareheritage.org/api/1/content/sha1_git:$blob/raw/"
  done <<< "$MANIFEST"
}

if ! from_linuxtv; then
  echo "git.linuxtv.org failed; fetching $COMMIT from Software Heritage" >&2
  from_software_heritage
fi
(cd "$SRC" && awk '{ print $1 "  " $3 }' <<< "$MANIFEST" | sha256sum --quiet -c -)

mkdir -p "$OUT"
sources=()
while read -r _ _ name; do [[ "$name" == *.cpp ]] && sources+=("$SRC/$name"); done <<< "$MANIFEST"
g++ -O1 -std=gnu++17 -DPACKAGE_VERSION="\"$COMMIT\"" -o "$BIN" "${sources[@]}"
echo "$COMMIT" > "$OUT/COMMIT"
echo "$BIN"
