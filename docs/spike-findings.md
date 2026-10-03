# Spike findings (2026-10-03) — partial, gate FAILED

| Constant / question | Value | Evidence |
|---|---|---|
| Emulator args | `/abs/path/fcadefbneo.exe quark:stream,sfiii3nr1,<quarkId>.7,7100` (no separate game arg) | `ps` while the client played 1791006077129-2245 |
| Quark suffix | the client appends `.7` to the quark ID from the link (meaning unknown) | `ps` |
| STREAM_PORT | 7100 | `ps` |
| Works without client running | launching that command ourselves opens the replay window (`wait` = 0) | our launch |
| Relative exe path | fails under wine.sh here (exit 53, looks in system32); absolute path works | Task 1 |
| Window | class `FinalBurn Neo`, title `Fightcade FBNeo v0.2.97.44-55 • Street Fighter III 3rd Strike...` | `fbneo-ctl list` |
| Record command | `WM_COMMAND 11827` works, then a `Set video compression option` dialog (#32770) blocks until OK; helper now confirms it (combo id 880, index 0 = Full Frames (Uncompressed)) | `fbneo-ctl codec-info` |
| AVI format | rawvideo 384x224 @ 59.59 fps + PCM s16le 44.1 kHz stereo | ffprobe |
| AVI file name | `sfiii3nr1-<MM-DD-HHMMSS>_0.avi` | ls |
| Kill method | `wine.sh taskkill /IM fcadefbneo.exe /F` works (exit 0, pgrep empty) | Task 1 |
| **AVI frames written** | **1 frame only, then the file never grows** — with the helper AND when recording by hand from the menu; with every codec (uncompressed: 346164 B; MS-RLE/Video 1/Cinepak: 2076 B headers only); with blitters nVidSelect 0/1/2/4 (3 never opens the dialog); with bAutoPause 0 | file sizes, ffprobe |
| Root cause (best evidence) | `WINEDEBUG=+avifile`: FBNeo calls `AVIStreamWrite` exactly once per stream and never again; at the same moment wined3d logs `GL_INVALID_FRAMEBUFFER_OPERATION from glBlitFramebuffer`. FBNeo's AVI writer appears to abort silently when reading back the frame under Wine | avidbg log |
| FFWD, end-of-replay, segments | not tested (blocked by the AVI failure) | — |

Conclusion: the spec's capture approach (FBNeo native AVI writer under Wine on macOS) does not work. Gate in plan Task 2 Step 12 fails; the design must change.

## Spike 2 (2026-10-03): our own build of Fightcade FBNeo — SUCCESS

| Question | Answer | Evidence |
|---|---|---|
| Source available? | Yes: github.com/fightcadeorg/fightcade-fbneo (has quark/GGPO glue); `ggponet.dll` is closed (header + import lib only) | repo |
| Builds on macOS? | Yes, mingw-w64 i686 cross-compile of the VS2015 file list (1094 files) in ~1 min on 10 cores; needed: perl/host generators, 3 MSVC-isms (`unsigned __int64`, CP1252 source, `ptr > 0`), stub for MSVC-asm `hq_shared32.cpp`, per-file rename of `nSavestateSlot` in luaengine, FBNeo's bundled XAudio2 2.7 header (mingw's 2.8 import fails in Fightcade's Wine) | spike/fbneo-build/build.py |
| Runs under Fightcade's Wine? | Yes with `nVidSelect 0` (DirectDraw) + `bVidFullStretch 1` in a private config; the DX9 Alt blitter crashes (divide by zero in VidSScaleImage / null D3DX font) | runs |
| Isolation | Runs from its own folder (our exe + Fightcade DLLs copied + ROMs symlink + own config): the Fightcade install and its inis are never touched | runtime dir |
| Dump | Hook after each frame in `RunFrame` (run.cpp) writing `pVidImage` rows + `nAudNextSound`; `bDraw` forced to 1 while dumping. Format: BGRA (bpp=4) 384x224 @ 59.59 fps, s16le 44.1 kHz stereo | info.txt |
| Completeness | Short replay 1791006077129-2245: 8220 frames = 137.94 s video vs 137.93 s audio; last frame = winner pose | ffprobe, frames |
| Speed | Fast-forward loop (`bAppDoFast` path, nFastSpeed=10) forced while dumping: 137.9 s of replay dumped in 22 s wall (≈6.3x). x264 `-preset slow` encode of it took 71 s — encoding is now the bottleneck | timings |
| End of replay | Stream does NOT send DISCONNECTED at the end: emulator idles waiting for input, so the dump simply stops growing → stall detection works; `QuarkFinishReplay` hook kept for real disconnects | file mtimes |
| Disk | raw dump ≈ 20 MB/s of replay (2.8 GB for 138 s) — pipe to ffmpeg or encode while dumping to avoid this | sizes |
| Quark suffix | `.7` suffix from the client was used; behaviour without it untested | — |

## Spike 3 (2026-10-03): Linux build, Linux run, Windows run

| Question | Answer | Evidence |
|---|---|---|
| Emulator builds on Linux? | **Yes** (Debian bookworm amd64, mingw-w64 GCC 12). Needs a host `g++` (generators) and a case fix: sources include `InitGuid.h`, mingw ships `initguid.h` (macOS is case-insensitive). Spike used a shim header via `CPLUS_INCLUDE_PATH`; build.py should create it. build.py also crashes with a traceback (not a clean error) when a tool is missing. | docker build |
| Runs under Linux Wine + Xvfb? | **Inconclusive.** On Apple Silicon, Docker runs 32-bit x86 through QEMU (Rosetta can't run i386): 0 frames after 15 min. Also seen: no `libGL` (Wine OpenGL disabled) and no sound card (ALSA errors) in the image — both need headless fixes (Mesa, dummy audio). Needs real x86_64 Linux. | ps shows qemu-i386 |
| Runs natively on Windows? | **Yes.** Windows 11, Ryzen 9 5900X, same exe built on macOS: exit 0 by itself after 38 s, 8220 frames, video 137.943 s / audio 137.932 s — identical to macOS. `d3dx9_43.dll` present (installed with Fightcade/DirectX). | user-run script |
