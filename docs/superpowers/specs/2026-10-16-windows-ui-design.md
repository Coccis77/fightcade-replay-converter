# fc2mp4-ui.exe (Windows window for fc2mp4) — Design

Date: 2026-10-16
Builds on: v0.14.0 (five supported games, PowerShell instructions in the README).

## 1. Goal and understanding

- **Outcome (user's words):** "a small UI for Windows to make it easier to use", "because using
  PowerShell is not user friendly".
- **Audience:** Windows players who are not at ease with a terminal.
- **What it is:** a separate small Windows app, `fc2mp4-ui.exe`, that the user points at an existing
  `fc2mp4.exe` and that runs it with a replay link and folders. It does not download fc2mp4 (user's
  choice) and does not replace the command line.
- **Constraints:** free and non-commercial (fc2mp4 license); unsigned like `fc2mp4.exe`; nothing extra
  to install (no Python, ffmpeg or runtime: fc2mp4 already downloads ffmpeg and the emulator itself).

### Success criteria

1. A user with Fightcade 2 (game opened once), `fc2mp4.exe` and `fc2mp4-ui.exe` in one folder can
   convert a replay by pasting its link and pressing Convert, then open the video from the window.
2. Progress and fc2mp4's full output are visible in the window; a failure shows fc2mp4's hint.
3. Cancel, or closing the window during a conversion, leaves nothing running (no emulator, no ffmpeg)
   and no temp files, as Ctrl-C does today.
4. Folders and the exe path are remembered between uses.
5. The command line behaves exactly as before.

## 2. Technology (approach 1)

C# WinForms targeting **.NET Framework 4.8** (built into Windows 10 and 11: no runtime to install),
one exe of roughly 100–200 KB, in a new `ui/` folder of this repo. Rejected: a PowerShell script
(Windows blocks downloaded `.ps1` files by default), Electron (~100 MB) and Tauri (Rust toolchain).

## 3. The window

Layout, top to bottom (resizable; title "fc2mp4"):

1. **Replay link** text field — focused at start, Enter starts the conversion. Not remembered.
2. **Convert** and **Cancel** buttons.
3. **Status line** — one line: ready / progress / done / failed / cancelled.
4. **Console** — read-only, selectable multi-line text with fc2mp4's output.
5. **Open video** and **Open folder** buttons — enabled after a success.
6. **Settings** group:
   - **fc2mp4.exe** + Browse… (file dialog). Default on first start: `fc2mp4.exe` in the window's own
     folder, if present.
   - **Fightcade folder** + Browse… (folder dialog). Optional; empty (shown as "found automatically")
     means fc2mp4 locates Fightcade itself.
   - **Output folder** + Browse… Default: `%USERPROFILE%\Videos\Fightcade`.
   - Help line: "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download
     automatically on the first conversion (about a minute)."

Settings (exe path, Fightcade folder, output folder) are saved in `%APPDATA%\fc2mp4-ui\settings.txt`
(one `key=value` per line) whenever a conversion starts and when the window closes; a missing or
unreadable file means defaults.

States:
- **Not ready:** exe missing, or too old (§5) → status says why ("Choose fc2mp4.exe in Settings" /
  "This fc2mp4.exe is too old for this window (vX): download the latest one"); Convert disabled.
- **Ready:** Convert enabled when the link field is not empty.
- **Running:** fields, Browse… and Convert disabled; Cancel enabled.
- **Finished:** "Done: <video path>" (Open buttons enabled) / "Failed: <hint or error>" /
  "Cancelled". Fields enabled again; the console keeps the last run's output until the next Convert.

## 4. Driving fc2mp4

- Command: `fc2mp4.exe <link> -o <output folder> [--fightcade-dir <folder>] --stop-on-stdin-close`,
  started without a console window, stdin/stdout/stderr redirected, read as UTF-8.
- Arguments are quoted by the Windows command-line rules (backslashes before a quote doubled, inner
  quotes escaped), so spaces, trailing `\` and quotes in paths are safe.
- The output folder is created (`Directory.CreateDirectory`) before starting: fc2mp4 treats a missing
  folder without a trailing separator as a file name.
- **stderr** → console, line by line (split on `\n` and `\r`). A line starting with `Capturing…`
  replaces the previous console line if that one also started with `Capturing…`, and is shown in the
  status line.
- **stdout** → its last non-empty line on success is the video path.
- **Exit code:** 0 → Done; 130 → Cancelled; other → Failed, status = the text after the last
  `Hint: ` line, else after the last `Error: ` line, else "fc2mp4 stopped (exit N)".
- If `fc2mp4.exe` cannot be started at all → Failed with the system's message.

### Stopping

- **fc2mp4 change:** new option `--stop-on-stdin-close` (convert command only; one line in `--help`:
  "Stop cleanly when standard input closes (for programs that run fc2mp4)"). With it, fc2mp4 reads
  stdin and, when it ends or closes, does exactly what the first Ctrl-C does: prints
  "Stopping…", aborts, and exits 130 after its usual cleanup. Without the option stdin is not read.
- **Cancel:** the window closes fc2mp4's stdin, waits up to 30 s for exit, then kills the process tree
  as a last resort and says "Cancelled (forced)".
- **Closing the window while running:** asks "Stop the conversion?" (Yes / No). Yes → Cancel, then the
  window closes once fc2mp4 exited. If the window process dies, Windows closes the pipe and fc2mp4
  stops itself.
- One conversion at a time from the window; fc2mp4's existing lock reports a run started elsewhere
  (its "busy" error is shown as any failure).

## 5. Version check

When the exe path is set (start, Browse…), the window runs `fc2mp4.exe --version` (5 s timeout). The
window is built with the version from `package.json`. If the exe's version is lower than the
window's, the window is **Not ready** with the "too old" message. `dev` or unparseable output → a
warning in the status line, Convert allowed.

## 6. Release and name

- Name: **`fc2mp4-ui.exe`**; window title "fc2mp4".
- Built by the existing release workflow on its Windows runner (`.github/workflows/cli.yml`), in the
  same `v*` releases and with the same version as `fc2mp4.exe`. First release: **v0.15.0**.
- Release notes and README: "Windows: download `fc2mp4.exe` and `fc2mp4-ui.exe` into the same
  folder, then open `fc2mp4-ui.exe`." The README Windows section shows the window first, PowerShell
  second. SmartScreen warning applies to both.

## 7. Testing

- **fc2mp4:** unit tests that, with `--stop-on-stdin-close`, stdin ending aborts like the first
  Ctrl-C, and that without it stdin is ignored; `parseCli` accepts the option.
- **Window logic** in small classes separate from the form, each unit-tested in CI on Windows:
  argument quoting (spaces, trailing `\`, quotes, empty), output handling (progress replacement,
  video path, hint/error extraction, exit codes), settings load/save (missing/bad file), version
  comparison.
- **Manual on Windows (user):** convert one replay; cancel one mid-capture and check Task Manager has
  no `fcadefbneo-fc2mp4.exe` / ffmpeg left; close the window during one, same check.

## 8. Out of scope

Downloading or updating fc2mp4 from the window, a queue of several links, converting from the web
page, macOS/Linux windows, an installer, code signing.
