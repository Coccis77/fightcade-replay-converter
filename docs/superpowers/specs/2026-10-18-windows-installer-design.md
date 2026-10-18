# Windows installer and auto-update — Design

Date: 2026-10-18
Builds on: v0.17.0 (window `fc2mp4-ui.exe` + tool `fc2mp4.exe` downloaded side by side; encoders).

## 1. Goal and understanding

- **Outcome (user's words):** "Having fc2mp4.exe and fc2mp4-ui.exe is not practical." Windows users get
  an installer "in program files or similar" and "an auto-updater if a new version is available".
- **User's choices:** per-user install (A); the window is `fc2mp4.exe`, the tool `fc2mp4-cli.exe`; no
  exe path in the window; a running installer over an existing install updates it; updates ask first
  (A); the old update signals are replaced; Inno Setup (approach 1); extras: done notification and
  several links in a row (not: clipboard auto-paste, PATH).
- **Unchanged:** free, unsigned (SmartScreen warns once, at install); macOS/Linux files and Docker;
  the command line's behaviour; the settings file location.

### Success criteria

1. A Windows user downloads `fc2mp4-setup.exe`, runs it without administrator rights, and gets
   "fc2mp4" in the Start menu and in "Installed apps".
2. Running a newer setup over an install updates it in place (same folder, settings kept).
3. When a newer release exists, the window offers it; "Update now" installs it and reopens the window
   on the new version; a failure leaves the old version working and offers the release page.
4. Several links convert one after the other; a failure does not stop the others.
5. A notification and a flashing taskbar button tell when a run ends while the window is in the
   background.

## 2. Installer (`installer/fc2mp4.iss`, Inno Setup 6)

- Fixed `AppId`; `PrivilegesRequired=lowest`; `DefaultDirName={localappdata}\Programs\fc2mp4`;
  `UsePreviousAppDir=yes` (an existing install is updated in place, wherever it is).
- Files: `fc2mp4.exe` (the window, built from `ui/`), `fc2mp4-cli.exe` (the Node tool), `LICENSE.txt`.
- Start-menu shortcut "fc2mp4"; optional desktop shortcut (task, unchecked by default).
- "Launch fc2mp4" at the end (checked); also run after a silent install (no `skipifsilent`), so an
  update reopens the window.
- An existing install shows the update wording; an installed version newer than the setup → warning
  "A newer version of fc2mp4 is already installed (vX)" with the choice to cancel.
- `CloseApplications=yes`: a running window is closed before files are replaced.
- Uninstall removes the program files and shortcuts; keeps `%APPDATA%\fc2mp4-ui` (settings) and
  `%LOCALAPPDATA%\fc2mp4` (emulator, ffmpeg cache); never touches videos.
- Version passed by CI (`/DAppVersion=<package.json version>`).

## 3. Release files

| File | For |
| --- | --- |
| `fc2mp4-setup.exe` | Windows users |
| `fc2mp4-cli.exe` | Windows command line / servers (was `fc2mp4.exe`) |
| `fc2mp4-macos-arm64`, `fc2mp4-linux-x64` | unchanged |

The window is no longer a separate download. Release notes start: "Windows: download
`fc2mp4-setup.exe` and run it. Command line: `fc2mp4-cli.exe`."

## 4. Updater (in the window)

- On start (not for version 0.0.0 local builds), one background request for GitHub's latest release
  (5 s timeout). Newer than the running version → bar at the top: "fc2mp4 vX is available."
  [Update now] [Later]. "Later" hides it until the next start. No answer → nothing shown.
- During a run the bar says "Update after this conversion finishes" and the button is disabled.
- Update now: download `https://github.com/Coccis77/fightcade-replay-converter/releases/download/vX/fc2mp4-setup.exe`
  to the temp folder with progress ("Downloading the update… 45%"); check it is complete (the length
  announced by the server) and a Windows program (starts with `MZ`); start it with
  `/SILENT /SUPPRESSMSGBOXES /NORESTART` (a progress window, no wizard pages); close the window. The installer replaces the files and
  reopens the window.
- After the restart, the status line says "Updated to vX" once (the window remembers the version it
  last ran in its settings file).
- Failure (download, check, or start): the bar says "The update couldn't be downloaded" (or
  "couldn't be started") with [Try again] and [Download from GitHub] (opens the release page).
  Nothing is changed. A failing installer keeps the old files (Inno Setup's behaviour).
- Removed: the "Download the latest fc2mp4" link, the status-line notice, the "— vX is available"
  suffix of the version line, and the "too old for this window" check (the window and the tool always
  ship together). The Settings version line stays.

## 5. Window changes

- **No exe path:** the window runs `fc2mp4-cli.exe` from its own folder; missing → status
  "fc2mp4-cli.exe is missing: reinstall fc2mp4", Convert disabled. Settings: Fightcade folder, Output
  folder, Encoder (+ description), help line, version line. The settings file stays at
  `%APPDATA%\fc2mp4-ui\settings.txt`; an old `exe=` line is ignored.
- **Several links:** the link field becomes a 3–4 line box; one link per line; blank lines and
  duplicates ignored; Convert (or Ctrl+Enter) runs them one after the other. Status "Converting 2 of
  3…" plus progress; console header per link `── 2/3  <link>`. A failure is recorded and the next link
  starts. Cancel stops the current one and skips the rest. End summary: "Done: 3 videos" /
  "2 done, 1 failed (see the console)" / "Cancelled after 1 of 3" (and "Done: <path>" for a single
  link, as today). Open video → the last finished video; Open folder → the output folder with it
  selected. The box keeps only the links that failed or were not converted.
- **Done notification:** at the end of a run, only if the window is not the active window: flash the
  taskbar button until activated, and show a Windows notification ("fc2mp4: 3 videos ready" /
  "fc2mp4: 2 done, 1 failed" / "fc2mp4: video ready"); clicking it activates the window. Uses
  `NotifyIcon` balloon tips (shown as Windows notifications) and `FlashWindowEx`.
- Unchanged: console, Cancel and stop-on-close, remembered settings, encoder choice.

## 6. CI and docs

- `ui` job builds the window as `fc2mp4.exe` (assembly name).
- New `installer` job (windows-latest, after the Windows `build` and `ui`): rename the tool to
  `fc2mp4-cli.exe`; install Inno Setup with choco if `iscc` is absent; compile
  `fc2mp4-setup.exe`; smoke test: silent install → both files present in
  `%LOCALAPPDATA%\Programs\fc2mp4` → `fc2mp4-cli.exe --version` prints the version → silent install
  again (update path) → silent uninstall → folder gone. Uploads `fc2mp4-setup.exe` and
  `fc2mp4-cli.exe`.
- Release job attaches the four files of §3.
- README Windows sections rewritten around the installer; PowerShell examples use
  `& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe"` (or the standalone `fc2mp4-cli.exe`); a note
  for people moving from the two-exe setup.
- Release v0.18.0.

## 7. Testing

- Unit (window logic): link-list parsing; queue results and summaries; which links stay in the box;
  notification text; update decision (newer/same/older/local build/no answer); setup download URL for
  a version; download checks (length, `MZ`); "Updated to vX" once; settings ignoring `exe=` and storing
  the last version run.
- CI: the installer smoke test above.
- Manual on Windows (user): install; 3 links with one broken, window in the background
  (notification); Cancel mid-run; setup run again over the install; Start menu and uninstall entry;
  Update now from a test build numbered below the real one.

## 8. Out of scope

Code signing, a per-machine (Program Files) install, delta updates, clipboard auto-paste, adding the
tool to PATH, macOS/Linux installers.
