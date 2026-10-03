# THROWAWAY spike code — not product code

Cross-compiles github.com/fightcadeorg/fightcade-fbneo (commit c959501) for Win32 on macOS with
mingw-w64 (`brew install mingw-w64`), adding a raw frame/audio dump (`extra/fc2mp4_dump.cpp`) and
small source patches (see `PATCHES` in `build.py`). Expects the source cloned at `../fcfb` relative
to this script (adjust `SRC_ROOT`). Kept only as the reference for the real build task; see
docs/spike-findings.md.
