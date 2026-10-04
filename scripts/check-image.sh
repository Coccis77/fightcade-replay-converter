#!/bin/bash
# Checks a built fc2mp4 image before it is published.
# Usage: scripts/check-image.sh <image> <version>
set -euo pipefail
IMAGE=$1
VERSION=$2
fail() { echo "FAIL: $*" >&2; exit 1; }

got=$(docker run --rm "$IMAGE" --version)
[ "$got" = "$VERSION" ] || fail "--version printed '$got', expected '$VERSION'"

docker run --rm --entrypoint sh "$IMAGE" -c \
  'test -f "$HOME/.cache/fc2mp4/runtime/fcadefbneo-fc2mp4.exe" && test -f "$HOME/.cache/fc2mp4/wineprefix/.fc2mp4-ready-2"' \
  || fail "the emulator or the Wine environment is missing from the image"

set +e
out=$(docker run --rm "$IMAGE" 1791006077129-2245 2>&1)
code=$?
set -e
[ "$code" = 3 ] || fail "a run without /fightcade exited $code, expected 3: $out"
echo "$out" | grep -q 'Fightcade files not found' || fail "unexpected message without /fightcade: $out"

echo "Image checks passed"
