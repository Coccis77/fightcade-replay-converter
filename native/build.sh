#!/bin/sh
# Builds the 32-bit helper (Fightcade's Wine prefix is win32).
set -eu
cd "$(dirname "$0")/.."
mkdir -p vendor
i686-w64-mingw32-gcc -O2 -s -Wall -Wextra -o vendor/fbneo-ctl.exe native/fbneo-ctl.c -luser32
echo "built vendor/fbneo-ctl.exe"
