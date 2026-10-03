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
