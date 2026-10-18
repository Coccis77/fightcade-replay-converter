# Windows Installer and Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows users install fc2mp4 with one `fc2mp4-setup.exe` (per user), the window updates itself from GitHub, converts several links in a row, and notifies when a run ends in the background.

**Architecture:** Pure logic stays in `ui/src/Core` (link list, batch of conversions, updater decisions, settings) with xUnit tests; the WinForms window wires it (runs `fc2mp4-cli.exe` beside itself, update bar, `NotifyIcon` + `FlashWindowEx`). An Inno Setup script (`installer/fc2mp4.iss`) packages the window (now `fc2mp4.exe`) and the tool (`fc2mp4-cli.exe`); a CI job builds it and smoke-tests install, update and uninstall on the Windows runner. Updating = downloading the release's `fc2mp4-setup.exe` and running it silently.

**Tech Stack:** C# / .NET Framework 4.8 WinForms (reference assemblies), xUnit on .NET 10, Inno Setup 6, GitHub Actions (windows-latest), TypeScript CLI unchanged.

**Spec:** `docs/superpowers/specs/2026-10-18-windows-installer-design.md`

## Global Constraints

- Install per user: `{localappdata}\Programs\fc2mp4`, `PrivilegesRequired=lowest`, fixed `AppId`, existing install updated in place.
- Names: window `fc2mp4.exe`, tool `fc2mp4-cli.exe`, installer `fc2mp4-setup.exe`.
- Release files: `fc2mp4-setup.exe`, `fc2mp4-cli.exe`, `fc2mp4-macos-arm64`, `fc2mp4-linux-x64`.
- Release notes start: "Windows: download `fc2mp4-setup.exe` and run it. Command line: `fc2mp4-cli.exe`."
- Settings file stays `%APPDATA%\fc2mp4-ui\settings.txt`; `exe=` ignored.
- Update bar: "fc2mp4 vX is available." [Update now] [Later]; during a run: "… Update after this conversion finishes." (button disabled); progress "Downloading the update… N%"; failure: [Try again] [Download from GitHub]; after update: status "Updated to vX" once.
- Silent install arguments: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`.
- Setup URL: `https://github.com/Coccis77/fightcade-replay-converter/releases/download/vX/fc2mp4-setup.exe`.
- Summaries: single link = today's message ("Done: <path>", "Failed: …", "Cancelled"); several: "Done: N videos" / "D done, F failed (see the console)" / "Cancelled after K of N". Status while running several: "Converting I of N: <detail>". Console header: `── I/N  <link>`.
- Notifications (only when the window is not active): "fc2mp4: video ready", "fc2mp4: conversion failed", "fc2mp4: N videos ready", "fc2mp4: D done, F failed"; none after Cancel.
- Missing tool: status "fc2mp4-cli.exe is missing: reinstall fc2mp4", Convert disabled.
- Version line: "Version: vX" (local build: "Version: development build").
- Release v0.18.0. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A local build (version 0.0.0) must never offer or attempt an update — Task 2 test.
2. Pasted text with Windows line endings, trailing spaces, blank lines and the same link twice must give each link once, in order — Task 1 test.
3. Cancel in the middle of several links: stop, keep the unconverted and failed links in the box, no notification — Task 1 test.
4. A truncated download, or an HTML error page saved instead of the installer, must never be run — Task 2 test.
5. A settings file from the two-exe era (with `exe=`) must load the folders and encoder unchanged — Task 2 test.

---

### Task 1: Link list and batch of conversions (window logic)

**Files:**
- Create: `ui/src/Core/LinkList.cs`, `ui/src/Core/Batch.cs`
- Modify: `ui/src/Core/RunOutcome.cs` (add `Failure`)
- Test: `ui/tests/LinkListTests.cs`, `ui/tests/BatchTests.cs`

**Interfaces:**
- Produces: `static class LinkList { List<string> Parse(string text); }`; `RunOutcome.Failure(string message)`; `sealed class Batch { Batch(IReadOnlyList<string> links); int Count; int Number /* 1-based current */; bool IsFinished; string CurrentLink; string Header(); string Progress(string detail); void Record(RunOutcome outcome); void Cancel(); string LastVideo; string Summary(); List<string> Remaining(); string NotificationText(); }`.

- [ ] **Step 1: Write the failing tests**

`ui/tests/LinkListTests.cs`:

```csharp
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class LinkListTests
    {
        [Fact]
        public void OneLinkPerLineTrimmedWithoutBlanksOrRepeats()
        {
            string text = "  https://replay.fightcade.com/fbneo/garou/1-1 \r\n\r\nhttps://replay.fightcade.com/fbneo/mk/2-2\r\n   \r\nhttps://replay.fightcade.com/fbneo/garou/1-1\n3-3";
            Assert.Equal(new[] { "https://replay.fightcade.com/fbneo/garou/1-1", "https://replay.fightcade.com/fbneo/mk/2-2", "3-3" }, LinkList.Parse(text));
        }

        [Fact]
        public void NothingForEmptyText()
        {
            Assert.Empty(LinkList.Parse(""));
            Assert.Empty(LinkList.Parse(null));
            Assert.Empty(LinkList.Parse(" \r\n \n"));
        }
    }
}
```

`ui/tests/BatchTests.cs`:

```csharp
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class BatchTests
    {
        static RunOutcome Done(string path) => RunOutcome.From(0, false, new[] { path }, new string[0]);
        static RunOutcome Failed(string hint) => RunOutcome.From(3, false, new string[0], new[] { "Error: x", "Hint: " + hint });
        static RunOutcome Cancelled() => RunOutcome.From(130, false, new string[0], new string[0]);

        [Fact]
        public void OneLinkKeepsTodaysMessages()
        {
            var b = new Batch(new[] { "a" });
            Assert.Equal("Starting…", b.Progress("Starting…"));
            b.Record(Done(@"C:\V\a.mp4"));
            Assert.True(b.IsFinished);
            Assert.Equal(@"Done: C:\V\a.mp4", b.Summary());
            Assert.Equal("fc2mp4: video ready", b.NotificationText());
            Assert.Empty(b.Remaining());

            var f = new Batch(new[] { "a" });
            f.Record(Failed("Open Garou"));
            Assert.Equal("Failed: Open Garou", f.Summary());
            Assert.Equal("fc2mp4: conversion failed", f.NotificationText());
            Assert.Equal(new[] { "a" }, f.Remaining());
        }

        [Fact]
        public void SeveralLinksRunInOrderAndAFailureDoesNotStopTheRest()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            Assert.Equal("── 1/3  a", b.Header());
            Assert.Equal("Converting 1 of 3: Capturing… 5s", b.Progress("Capturing… 5s"));
            b.Record(Done(@"C:\V\a.mp4"));
            Assert.Equal(2, b.Number);
            Assert.Equal("b", b.CurrentLink);
            b.Record(Failed("ROM missing"));
            Assert.False(b.IsFinished);
            b.Record(Done(@"C:\V\c.mp4"));
            Assert.True(b.IsFinished);
            Assert.Equal("2 done, 1 failed (see the console)", b.Summary());
            Assert.Equal("fc2mp4: 2 done, 1 failed", b.NotificationText());
            Assert.Equal(new[] { "b" }, b.Remaining());
            Assert.Equal(@"C:\V\c.mp4", b.LastVideo);
        }

        [Fact]
        public void AllDone()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            b.Record(Done("1"));
            b.Record(Done("2"));
            b.Record(Done("3"));
            Assert.Equal("Done: 3 videos", b.Summary());
            Assert.Equal("fc2mp4: 3 videos ready", b.NotificationText());
        }

        [Fact]
        public void CancelStopsTheRunKeepsTheRestAndDoesNotNotify()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            b.Record(Done(@"C:\V\a.mp4"));
            b.Record(Cancelled());
            b.Cancel();
            Assert.True(b.IsFinished);
            Assert.Equal("Cancelled after 1 of 3", b.Summary());
            Assert.Null(b.NotificationText());
            Assert.Equal(new[] { "b", "c" }, b.Remaining());

            var one = new Batch(new[] { "a" });
            one.Record(Cancelled());
            one.Cancel();
            Assert.Equal("Cancelled", one.Summary());
            Assert.Null(one.NotificationText());
        }

        [Fact]
        public void AFailureToStartIsAFailedLink()
        {
            Assert.Equal("Failed: could not start fc2mp4-cli.exe: boom", RunOutcome.Failure("could not start fc2mp4-cli.exe: boom").Message);
            Assert.Equal(OutcomeKind.Failed, RunOutcome.Failure("x").Kind);
        }
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo`
Expected: FAIL to compile — `LinkList`, `Batch`, `RunOutcome.Failure` missing.

- [ ] **Step 3: Implement**

`ui/src/Core/LinkList.cs`:

```csharp
using System;
using System.Collections.Generic;

namespace Fc2mp4Ui
{
    // The links box: one replay link per line; blank lines and repeats are ignored, order is kept.
    public static class LinkList
    {
        public static List<string> Parse(string text)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var links = new List<string>();
            foreach (string raw in (text ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string link = raw.Trim();
                if (link.Length > 0 && seen.Add(link)) links.Add(link);
            }
            return links;
        }
    }
}
```

`ui/src/Core/RunOutcome.cs`: add inside the class:

```csharp
        // fc2mp4-cli.exe could not even be started for this link.
        public static RunOutcome Failure(string message) => new RunOutcome { Kind = OutcomeKind.Failed, Message = "Failed: " + message };
```

`ui/src/Core/Batch.cs`:

```csharp
using System.Collections.Generic;
using System.Linq;

namespace Fc2mp4Ui
{
    // The links of one Convert, converted one after the other. A failed link does not stop the others;
    // Cancel stops the run. One link keeps the single-conversion messages.
    public sealed class Batch
    {
        readonly List<string> links;
        readonly List<RunOutcome> results = new List<RunOutcome>();
        bool cancelled;

        public Batch(IReadOnlyList<string> links) { this.links = new List<string>(links); }

        public int Count => links.Count;
        public int Number => results.Count + 1;
        public bool IsFinished => cancelled || results.Count >= links.Count;
        public string CurrentLink => links[results.Count];
        public string Header() => "── " + Number + "/" + Count + "  " + CurrentLink;
        public string Progress(string detail) => Count == 1 ? detail : "Converting " + Number + " of " + Count + ": " + detail;

        public void Record(RunOutcome outcome) => results.Add(outcome);
        public void Cancel() => cancelled = true;

        public string LastVideo => results.LastOrDefault(r => r.Kind == OutcomeKind.Done)?.VideoPath;

        bool WasCancelled => cancelled || results.Any(r => r.Kind == OutcomeKind.Cancelled);
        int DoneCount => results.Count(r => r.Kind == OutcomeKind.Done);
        int FailedCount => results.Count(r => r.Kind == OutcomeKind.Failed);

        public string Summary()
        {
            if (Count == 1 && results.Count == 1) return results[0].Message;
            if (WasCancelled) return "Cancelled after " + (DoneCount + FailedCount) + " of " + Count;
            return FailedCount == 0 ? "Done: " + DoneCount + " videos" : DoneCount + " done, " + FailedCount + " failed (see the console)";
        }

        // What stays in the links box: the links that failed or were not converted.
        public List<string> Remaining()
        {
            var left = new List<string>();
            for (int i = 0; i < links.Count; i++)
                if (i >= results.Count || results[i].Kind != OutcomeKind.Done) left.Add(links[i]);
            return left;
        }

        // Null after Cancel: the user is there.
        public string NotificationText()
        {
            if (WasCancelled) return null;
            if (Count == 1) return DoneCount == 1 ? "fc2mp4: video ready" : "fc2mp4: conversion failed";
            return FailedCount == 0 ? "fc2mp4: " + DoneCount + " videos ready" : "fc2mp4: " + DoneCount + " done, " + FailedCount + " failed";
        }
    }
}
```

- [ ] **Step 4: Run the tests and build**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo && dotnet build ui/src/Fc2mp4Ui.csproj -c Release -nologo`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): link list and batch of conversions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Updater decisions and settings (window logic)

**Files:**
- Create: `ui/src/Core/Updater.cs`; Test: `ui/tests/UpdaterTests.cs`
- Modify: `ui/src/Core/Settings.cs`, `ui/src/Core/UpdateCheck.cs`, `ui/src/Core/VersionCheck.cs`
- Test: `ui/tests/SettingsTests.cs`, `ui/tests/UpdateCheckTests.cs`; delete `ui/tests/VersionCheckTests.cs`

**Interfaces:**
- Produces: `static class Updater { const string SilentArgs; bool IsLocalBuild(Version v); bool Offer(Version latest, Version running); string SetupUrl(Version v); string CheckDownload(byte[] head, long length, long expected); string UpdatedNotice(string lastRun, Version running); string VersionText(Version running); string VersionLabel(Version running); }`; `Settings { FightcadeFolder; OutputFolder; Encoder; LastVersion; static Load(string path, string defaultOutput); Save(string path); }` (no `Exe`); `UpdateCheck { ReleasesUrl; ApiUrl; ParseLatestTag(string) }` only; `VersionCheck { Parse(string) }` only.

- [ ] **Step 1: Write the failing tests**

`ui/tests/UpdaterTests.cs`:

```csharp
using System;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class UpdaterTests
    {
        static readonly Version Running = new Version(0, 18, 0, 0);
        static readonly Version Local = new Version(0, 0, 0, 0);

        [Fact]
        public void OffersOnlyANewerRelease()
        {
            Assert.True(Updater.Offer(new Version(0, 19, 0), Running));
            Assert.False(Updater.Offer(new Version(0, 18, 0), Running));
            Assert.False(Updater.Offer(new Version(0, 17, 0), Running));
            Assert.False(Updater.Offer(null, Running)); // GitHub not reachable
        }

        [Fact]
        public void ALocalBuildNeverUpdates()
        {
            Assert.True(Updater.IsLocalBuild(Local));
            Assert.False(Updater.Offer(new Version(9, 0, 0), Local));
            Assert.Null(Updater.UpdatedNotice("0.17.0", Local));
            Assert.Equal("Version: development build", Updater.VersionLabel(Local));
            Assert.Equal("", Updater.VersionText(Local));
        }

        [Fact]
        public void DownloadsTheExactVersionsInstaller()
        {
            Assert.Equal("https://github.com/Coccis77/fightcade-replay-converter/releases/download/v0.19.0/fc2mp4-setup.exe", Updater.SetupUrl(new Version(0, 19, 0)));
            Assert.Equal("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART", Updater.SilentArgs);
        }

        [Fact]
        public void RunsOnlyAWholeWindowsProgram()
        {
            byte[] mz = { (byte)'M', (byte)'Z' };
            Assert.Null(Updater.CheckDownload(mz, 1000, 1000));
            Assert.Null(Updater.CheckDownload(mz, 1000, -1)); // length not announced
            Assert.Equal("The update couldn't be downloaded completely", Updater.CheckDownload(mz, 999, 1000));
            Assert.Equal("The update download isn't a Windows program", Updater.CheckDownload(new[] { (byte)'<', (byte)'!' }, 1000, 1000));
            Assert.Equal("The update download isn't a Windows program", Updater.CheckDownload(new byte[0], 0, -1));
        }

        [Fact]
        public void SaysUpdatedOnceAfterAnUpdate()
        {
            Assert.Equal("Updated to v0.18.0", Updater.UpdatedNotice("0.17.0", Running));
            Assert.Null(Updater.UpdatedNotice("0.18.0", Running));
            Assert.Null(Updater.UpdatedNotice("", Running)); // first run ever
            Assert.Null(Updater.UpdatedNotice("garbage", Running));
            Assert.Equal("0.18.0", Updater.VersionText(Running));
            Assert.Equal("Version: v0.18.0", Updater.VersionLabel(Running));
        }
    }
}
```

`ui/tests/SettingsTests.cs`: change every `Settings.Load(path, x, y)` to the two-argument form `Settings.Load(path, y)` (the default output folder) and every `Exe = …`/`s.Exe` use is removed; replace the round-trip test's object with `new Settings { FightcadeFolder = @"D:\Fight cade", OutputFolder = @"C:\a=b\Out", Encoder = "qsv", LastVersion = "0.18.0" }` and assert the four values back; add:

```csharp
        [Fact]
        public void ASettingsFileFromTheTwoExeSetupStillLoads()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=C:\\Tools\\fc2mp4.exe\nfightcade=D:\\FC\noutput=E:\\Out\nencoder=nvenc\n");
            var s = Settings.Load(path, "defOut");
            Assert.Equal(@"D:\FC", s.FightcadeFolder);
            Assert.Equal(@"E:\Out", s.OutputFolder);
            Assert.Equal("nvenc", s.Encoder);
            Assert.Equal("", s.LastVersion);
        }
```

`ui/tests/UpdateCheckTests.cs`: delete the `LabelsTheExeVersion`, `NoNoticeWhenUpToDateOrUnknown`, `TellsWhichFilesToDownloadAgain`, `ALocalWindowBuildOnlyComparesTheExe`, `HidesTheDownloadLinkWhenEverythingIsUpToDate` and `ShowsTheDownloadLinkWhenSomethingIsNewerOrMissing` tests (keep tag parsing and `ParsesVersionsLikeFc2mp4PrintsThem`). Delete `ui/tests/VersionCheckTests.cs`.

- [ ] **Step 2: Run them to verify they fail**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo`
Expected: FAIL to compile — `Updater` missing, `Settings.Load` arity, `LastVersion`.

- [ ] **Step 3: Implement**

`ui/src/Core/Updater.cs`:

```csharp
using System;

namespace Fc2mp4Ui
{
    // Updating = running the release's installer silently over this install (Inno Setup replaces both exes
    // and reopens the window). A local build (version 0.0.0) never updates.
    public static class Updater
    {
        public const string SilentArgs = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART";

        static Version Short(Version v) => new Version(v.Major, v.Minor, Math.Max(v.Build, 0));

        public static bool IsLocalBuild(Version v) => v == null || Short(v) == new Version(0, 0, 0);

        public static bool Offer(Version latest, Version running) => latest != null && !IsLocalBuild(running) && Short(latest) > Short(running);

        // The exact version offered, not "latest": it cannot change between the offer and the download.
        public static string SetupUrl(Version v) => "https://github.com/Coccis77/fightcade-replay-converter/releases/download/v" + Short(v) + "/fc2mp4-setup.exe";

        // Null when the file can be run: complete (when the server announced a length) and a Windows program.
        public static string CheckDownload(byte[] head, long length, long expected)
        {
            if (expected > 0 && length != expected) return "The update couldn't be downloaded completely";
            if (head == null || head.Length < 2 || length < 2 || head[0] != (byte)'M' || head[1] != (byte)'Z') return "The update download isn't a Windows program";
            return null;
        }

        // "Updated to vX" once: the settings remember the last version that ran.
        public static string UpdatedNotice(string lastRun, Version running)
        {
            if (IsLocalBuild(running)) return null;
            Version last = VersionCheck.Parse(lastRun);
            return last != null && last < Short(running) ? "Updated to v" + Short(running) : null;
        }

        public static string VersionText(Version running) => IsLocalBuild(running) ? "" : Short(running).ToString();

        public static string VersionLabel(Version running) => IsLocalBuild(running) ? "Version: development build" : "Version: v" + Short(running);
    }
}
```

`ui/src/Core/Settings.cs` (whole file):

```csharp
using System;
using System.IO;
using System.Text;

namespace Fc2mp4Ui
{
    // %APPDATA%\fc2mp4-ui\settings.txt: fightcade=, output=, encoder=, last= (the version that last ran).
    // The link is never saved; exe= (from the two-exe setup) is ignored.
    public sealed class Settings
    {
        public string FightcadeFolder { get; set; } = "";
        public string OutputFolder { get; set; } = "";
        public string Encoder { get; set; } = "auto";
        public string LastVersion { get; set; } = "";

        public static Settings Load(string path, string defaultOutput)
        {
            var s = new Settings { OutputFolder = defaultOutput };
            string[] lines;
            try { lines = File.ReadAllLines(path, Encoding.UTF8); }
            catch (Exception) { return s; }
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key == "fightcade") s.FightcadeFolder = value;
                else if (key == "output" && value.Length > 0) s.OutputFolder = value;
                else if (key == "encoder") s.Encoder = Encoders.Normalize(value);
                else if (key == "last") s.LastVersion = value;
            }
            return s;
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "fightcade=" + FightcadeFolder + "\noutput=" + OutputFolder + "\nencoder=" + Encoder + "\nlast=" + LastVersion + "\n", new UTF8Encoding(false));
        }
    }
}
```

`ui/src/Core/UpdateCheck.cs`: delete `VersionLabel`, `ShowDownloadLink` and `Notice` (keep the URLs and `ParseLatestTag`); change its header comment to "The latest fc2mp4 release on GitHub."

`ui/src/Core/VersionCheck.cs`: delete `VersionStatus`, `VersionVerdict` and `Evaluate`; keep `Semver` and `Parse` (header comment: "Versions as fc2mp4 prints them and as release tags name them.").

- [ ] **Step 4: Run the tests**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo`
Expected: PASS. (`ui/src` will not build until Task 3 rewrites the window; that is expected in this task.)

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): updater decisions; settings without the exe path, with the last version run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The window: tool beside it, several links, update bar, notification

**Files:**
- Modify: `ui/src/MainForm.cs` (rewrite), `ui/src/ConversionRunner.cs` (remove `ReadVersion`), `ui/src/Fc2mp4Ui.csproj` (`AssemblyName` → `fc2mp4`)

**Interfaces:**
- Consumes: `LinkList`, `Batch`, `RunOutcome.Failure`, `Updater`, `Settings` (Tasks 1–2); `UpdateCheck.ApiUrl/ReleasesUrl/ParseLatestTag`; `Encoders`, `Fc2mp4Command.Arguments(link, output, fightcade, encoder)`, `OutputFolder.Ensure`, `OutputLog`, `RunState`, `ConversionRunner` (existing).
- Produces: the window built as `fc2mp4.exe`.

These are WinForms and Windows APIs: checked by building here and by the Windows checks in Task 5.

- [ ] **Step 1: `ui/src/Fc2mp4Ui.csproj`** — `<AssemblyName>fc2mp4</AssemblyName>`.

- [ ] **Step 2: `ui/src/ConversionRunner.cs`** — delete the `ReadVersion` method (the window shows its own version).

- [ ] **Step 3: Replace `ui/src/MainForm.cs`**

```csharp
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    public sealed class MainForm : Form
    {
        const string HelpText = "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).";

        readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fc2mp4-ui", "settings.txt");
        readonly string cliPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fc2mp4-cli.exe");
        readonly Version windowVersion = typeof(MainForm).Assembly.GetName().Version;
        readonly ConversionRunner runner = new ConversionRunner();
        readonly RunState state = new RunState();
        readonly List<Button> browseButtons = new List<Button>();
        readonly NotifyIcon notifier = new NotifyIcon { Icon = SystemIcons.Application, Text = "fc2mp4" };

        readonly FlowLayoutPanel updateBar = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Visible = false, BackColor = SystemColors.Info, Padding = new Padding(4), WrapContents = false };
        readonly Label updateText = new Label { AutoSize = true, Padding = new Padding(0, 6, 8, 0) };
        readonly Button updateNow = new Button { Text = "Update now", AutoSize = true };
        readonly Button updateLater = new Button { Text = "Later", AutoSize = true };
        readonly Button updateGitHub = new Button { Text = "Download from GitHub", AutoSize = true, Visible = false };

        readonly TextBox links = new TextBox { Dock = DockStyle.Fill, Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, Height = 64 };
        readonly Button convert = new Button { Text = "Convert", AutoSize = true };
        readonly Button cancel = new Button { Text = "Cancel", AutoSize = true, Enabled = false };
        readonly Label status = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
        readonly TextBox console = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font(FontFamily.GenericMonospace, 9f), BackColor = SystemColors.Window };
        readonly Button openVideo = new Button { Text = "Open video", AutoSize = true, Enabled = false };
        readonly Button openFolder = new Button { Text = "Open folder", AutoSize = true, Enabled = false };
        readonly TextBox fightcade = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox output = new TextBox { Dock = DockStyle.Fill };
        readonly ComboBox encoder = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
        readonly Label encoderHelp = new Label { AutoSize = true, MaximumSize = new Size(560, 0), ForeColor = SystemColors.GrayText };
        readonly Label versionLabel = new Label { AutoSize = true, Anchor = AnchorStyles.Left };

        Settings settings;
        string startNotice;
        bool cliPresent;
        Batch batch;
        string consoleBefore = "";
        OutputLog log = new OutputLog();
        List<string> stdout = new List<string>();
        List<string> stderr = new List<string>();
        string videoPath;
        Version latestVersion;
        bool updateDismissed;
        bool updating;
        string updateError;

        public MainForm()
        {
            Text = "fc2mp4";
            MinimumSize = new Size(640, 520);
            Size = new Size(760, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BuildLayout();

            string defaultOutput = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Videos", "Fightcade");
            settings = Settings.Load(settingsPath, defaultOutput);
            fightcade.Text = settings.FightcadeFolder;
            output.Text = settings.OutputFolder;
            encoder.Items.AddRange(Encoders.Labels);
            encoder.SelectedIndex = Array.IndexOf(Encoders.Names, settings.Encoder);
            encoderHelp.Text = Encoders.Describe(settings.Encoder);
            encoder.SelectedIndexChanged += (s, e) => encoderHelp.Text = Encoders.Describe(SelectedEncoder());
            versionLabel.Text = Updater.VersionLabel(windowVersion);
            startNotice = Updater.UpdatedNotice(settings.LastVersion, windowVersion);
            settings.LastVersion = Updater.VersionText(windowVersion);
            SaveSettings();

            links.TextChanged += (s, e) => UpdateButtons();
            links.KeyDown += (s, e) => { if (e.Control && e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; StartRun(); } };
            convert.Click += (s, e) => StartRun();
            cancel.Click += async (s, e) => await StopAsync();
            openVideo.Click += (s, e) => { if (videoPath != null) Run(new ProcessStartInfo(videoPath) { UseShellExecute = true }); };
            openFolder.Click += (s, e) => { if (videoPath != null) Run(new ProcessStartInfo("explorer.exe", "/select," + WindowsArgs.Quote(videoPath))); };
            updateNow.Click += (s, e) => UpdateNow();
            updateLater.Click += (s, e) => { updateDismissed = true; ShowUpdateBar(); };
            updateGitHub.Click += (s, e) => Run(new ProcessStartInfo(UpdateCheck.ReleasesUrl) { UseShellExecute = true });
            notifier.BalloonTipClicked += (s, e) => { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); };
            runner.StderrLine += line => Post(() => OnStderr(line));
            runner.StdoutLine += line => Post(() => stdout.Add(line));
            runner.Exited += (code, forced) => Post(() => OnExited(code, forced));
            Shown += (s, e) => { CheckCli(); links.Focus(); _ = CheckForUpdateAsync(); };
            FormClosing += OnClosing;
            FormClosed += (s, e) => notifier.Dispose();
        }

        void BuildLayout()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10) };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // update bar
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // links
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // buttons
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));   // status
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // console
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // open buttons
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // settings

            updateBar.Controls.Add(updateText);
            updateBar.Controls.Add(updateNow);
            updateBar.Controls.Add(updateLater);
            updateBar.Controls.Add(updateGitHub);
            root.Controls.Add(updateBar);

            var linkRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            linkRow.Controls.Add(new Label { Text = "Replay links\n(one per line)", AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Top }, 0, 0);
            linkRow.Controls.Add(links, 1, 0);
            root.Controls.Add(linkRow);

            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
            actions.Controls.Add(cancel);
            actions.Controls.Add(convert);
            root.Controls.Add(actions);

            root.Controls.Add(status);
            root.Controls.Add(console);

            var opens = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
            opens.Controls.Add(openFolder);
            opens.Controls.Add(openVideo);
            root.Controls.Add(opens);

            var group = new GroupBox { Text = "Settings", Dock = DockStyle.Fill, AutoSize = true, Padding = new Padding(8) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            AddPathRow(grid, 0, "Fightcade folder", fightcade, () => BrowseFolder(fightcade, "Fightcade folder (the one that contains emulator\\fbneo)"));
            AddPathRow(grid, 1, "Output folder", output, () => BrowseFolder(output, "Folder for the videos"));
            grid.Controls.Add(new Label { Text = "Encoder", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
            grid.Controls.Add(encoder, 1, 2);
            grid.SetColumnSpan(encoder, 2);
            grid.Controls.Add(encoderHelp, 1, 3);
            grid.SetColumnSpan(encoderHelp, 2);
            grid.Controls.Add(versionLabel, 1, 4);
            grid.SetColumnSpan(versionLabel, 2);
            var help = new Label { Text = HelpText, AutoSize = true, MaximumSize = new Size(680, 0), ForeColor = SystemColors.GrayText, Padding = new Padding(0, 6, 0, 0) };
            grid.Controls.Add(help, 0, 5);
            grid.SetColumnSpan(help, 3);
            group.Controls.Add(grid);
            root.Controls.Add(group);

            Controls.Add(root);
        }

        void AddPathRow(TableLayoutPanel grid, int row, string label, TextBox box, Action browse)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            grid.Controls.Add(box, 1, row);
            var button = new Button { Text = "Browse…", AutoSize = true };
            button.Click += (s, e) => browse();
            browseButtons.Add(button);
            grid.Controls.Add(button, 2, row);
        }

        void BrowseFolder(TextBox box, string description)
        {
            using (var dialog = new FolderBrowserDialog { Description = description, SelectedPath = box.Text })
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
        }

        void CheckCli()
        {
            cliPresent = File.Exists(cliPath);
            status.Text = !cliPresent ? "fc2mp4-cli.exe is missing: reinstall fc2mp4" : startNotice ?? "Ready";
            startNotice = null;
            UpdateButtons();
        }

        void Run(ProcessStartInfo start)
        {
            try { Process.Start(start); }
            catch (Exception e) { status.Text = "Could not open it: " + e.Message; }
        }

        // Events from fc2mp4-cli arrive on other threads; once the window is gone they are dropped.
        void Post(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { } // includes ObjectDisposedException
        }

        void UpdateButtons()
        {
            bool running = state.Running;
            convert.Enabled = cliPresent && !running && !updating && LinkList.Parse(links.Text).Count > 0;
            cancel.Enabled = running && !state.Stopping;
            foreach (var box in new[] { links, fightcade, output }) box.ReadOnly = running;
            foreach (var button in browseButtons) button.Enabled = !running;
            encoder.Enabled = !running;
            ShowUpdateBar();
        }

        string SelectedEncoder() => encoder.SelectedIndex >= 0 ? Encoders.Names[encoder.SelectedIndex] : "auto";

        void SaveSettings()
        {
            settings.FightcadeFolder = fightcade.Text.Trim();
            settings.OutputFolder = output.Text.Trim();
            settings.Encoder = SelectedEncoder();
            try { settings.Save(settingsPath); } catch (Exception) { }
        }

        // ---- Conversions: the links one after the other ----

        void StartRun()
        {
            if (!convert.Enabled) return;
            string folderError = OutputFolder.Ensure(output.Text);
            if (folderError != null) { status.Text = "Failed: " + folderError; return; }
            SaveSettings();
            batch = new Batch(LinkList.Parse(links.Text));
            consoleBefore = "";
            console.Text = "";
            videoPath = null;
            openVideo.Enabled = openFolder.Enabled = false;
            state.Started();
            UpdateButtons();
            RunNext();
        }

        void RunNext()
        {
            if (state.Stopping) batch.Cancel();
            if (batch.IsFinished) { FinishRun(); return; }
            log = new OutputLog();
            stdout = new List<string>();
            stderr = new List<string>();
            if (batch.Count > 1) consoleBefore += (consoleBefore.Length > 0 ? Environment.NewLine + Environment.NewLine : "") + batch.Header() + Environment.NewLine;
            console.Text = consoleBefore;
            status.Text = batch.Progress("Starting…");
            try
            {
                runner.Start(cliPath, Fc2mp4Command.Arguments(batch.CurrentLink, output.Text, fightcade.Text, SelectedEncoder()));
            }
            catch (Exception e)
            {
                var failed = RunOutcome.Failure("could not start fc2mp4-cli.exe: " + e.Message);
                consoleBefore += failed.Message;
                batch.Record(failed);
                Post(RunNext);
            }
        }

        void OnStderr(string line)
        {
            stderr.Add(line);
            log.Add(line);
            console.Text = consoleBefore + log.Text;
            console.SelectionStart = console.TextLength;
            console.ScrollToCaret();
            if (state.ShowsProgress && log.Progress != null && line == log.Progress) status.Text = batch.Progress(line);
        }

        void OnExited(int code, bool forced)
        {
            var outcome = RunOutcome.From(code, forced, stdout, stderr);
            consoleBefore = console.Text;
            if (batch.Count > 1) consoleBefore += Environment.NewLine + outcome.Message;
            batch.Record(outcome);
            if (outcome.Kind == OutcomeKind.Done) videoPath = outcome.VideoPath;
            RunNext();
        }

        void FinishRun()
        {
            bool close = state.Finished();
            console.Text = consoleBefore;
            status.Text = batch.Summary();
            links.Text = string.Join(Environment.NewLine, batch.Remaining());
            videoPath = batch.LastVideo;
            openVideo.Enabled = openFolder.Enabled = videoPath != null && File.Exists(videoPath);
            Notify(batch.NotificationText());
            UpdateButtons();
            if (close) Close();
        }

        async Task StopAsync()
        {
            if (!state.CancelRequested()) return;
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }

        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            CloseAction action = state.CloseRequested();
            if (action == CloseAction.CloseNow) { SaveSettings(); return; }
            e.Cancel = true;
            if (action == CloseAction.Wait) return;
            if (MessageBox.Show(this, "Stop the conversion?", "fc2mp4", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            if (!state.CloseConfirmed()) { Post(Close); return; }
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }

        // ---- Done notification (only when the window is in the background) ----

        [StructLayout(LayoutKind.Sequential)]
        struct FlashInfo
        {
            public uint Size;
            public IntPtr Window;
            public uint Flags;
            public uint Count;
            public uint Timeout;
        }

        [DllImport("user32.dll")]
        static extern bool FlashWindowEx(ref FlashInfo info);

        const uint FlashAll = 3, FlashUntilForeground = 12;

        void Notify(string text)
        {
            if (text == null || ActiveForm == this) return;
            var info = new FlashInfo { Size = (uint)Marshal.SizeOf(typeof(FlashInfo)), Window = Handle, Flags = FlashAll | FlashUntilForeground };
            FlashWindowEx(ref info);
            notifier.Visible = true;
            notifier.ShowBalloonTip(5000, "fc2mp4", text, ToolTipIcon.Info);
        }

        // ---- Updates ----

        async Task CheckForUpdateAsync()
        {
            if (Updater.IsLocalBuild(windowVersion)) return;
            Version latest = await Task.Run(() => FetchLatestVersion());
            Post(() => { latestVersion = latest; ShowUpdateBar(); });
        }

        static Version FetchLatestVersion()
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; // GitHub refuses older TLS
                var request = (HttpWebRequest)WebRequest.Create(UpdateCheck.ApiUrl);
                request.UserAgent = "fc2mp4"; // required by the GitHub API
                request.Accept = "application/vnd.github+json";
                request.Timeout = 5_000;
                request.ReadWriteTimeout = 5_000;
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return UpdateCheck.ParseLatestTag(reader.ReadToEnd());
            }
            catch (Exception) { return null; }
        }

        void ShowUpdateBar()
        {
            if (!Updater.Offer(latestVersion, windowVersion) || updateDismissed) { updateBar.Visible = false; return; }
            updateBar.Visible = true;
            updateGitHub.Visible = updateError != null;
            updateNow.Text = updateError != null ? "Try again" : "Update now";
            updateNow.Enabled = !state.Running && !updating;
            updateLater.Enabled = !updating;
            if (updating) return; // the download shows its own progress
            string offer = "fc2mp4 v" + latestVersion + " is available.";
            updateText.Text = updateError ?? (state.Running ? offer + " Update after this conversion finishes." : offer);
        }

        async void UpdateNow()
        {
            updating = true;
            updateError = null;
            UpdateButtons();
            updateText.Text = "Downloading the update…";
            Version version = latestVersion;
            string setup = Path.Combine(Path.GetTempPath(), "fc2mp4-setup-v" + version + ".exe");
            string error = await Task.Run(() => Download(Updater.SetupUrl(version), setup, percent => Post(() => updateText.Text = "Downloading the update… " + percent + "%")));
            if (error == null)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(setup, Updater.SilentArgs) { UseShellExecute = true });
                    Close(); // the installer replaces the files and reopens the window
                    return;
                }
                catch (Exception e) { error = "The update couldn't be started: " + e.Message; }
            }
            updating = false;
            updateError = error;
            UpdateButtons();
        }

        static string Download(string url, string path, Action<int> progress)
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.UserAgent = "fc2mp4";
                request.Timeout = 15_000;
                request.ReadWriteTimeout = 30_000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var input = response.GetResponseStream())
                using (var file = File.Create(path))
                {
                    long expected = response.ContentLength, total = 0;
                    var buffer = new byte[81920];
                    var head = new byte[2];
                    int headLength = 0, last = -1, read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (headLength < 2)
                        {
                            int take = Math.Min(2 - headLength, read);
                            Array.Copy(buffer, 0, head, headLength, take);
                            headLength += take;
                        }
                        file.Write(buffer, 0, read);
                        total += read;
                        if (expected > 0)
                        {
                            int percent = (int)(total * 100 / expected);
                            if (percent != last) { last = percent; progress(percent); }
                        }
                    }
                    if (headLength < 2) head = new byte[0];
                    return Updater.CheckDownload(head, total, expected);
                }
            }
            catch (Exception e) { return "The update couldn't be downloaded: " + e.Message; }
        }
    }
}
```

- [ ] **Step 4: Build and test**

Run: `dotnet build ui/src/Fc2mp4Ui.csproj -c Release -p:Version=0.18.0 -nologo && ls ui/src/bin/Release/net48/fc2mp4.exe && dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo`
Expected: build succeeds with 0 warnings; `fc2mp4.exe` exists; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): run fc2mp4-cli.exe beside the window, several links, update bar, done notification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Installer, CI and docs

**Files:**
- Create: `installer/fc2mp4.iss`
- Modify: `.github/workflows/cli.yml`, `README.md`, `.gitignore` (nothing: `build/` already ignored)

**Interfaces:**
- Consumes: window `ui/src/bin/Release/net48/fc2mp4.exe` (Task 3); the Windows tool from the `build` job.
- Produces: artifacts and release assets `fc2mp4-setup.exe`, `fc2mp4-cli.exe`.

- [ ] **Step 1: Write `installer/fc2mp4.iss`**

```iss
; fc2mp4 for Windows: the window (fc2mp4.exe) and the command-line tool (fc2mp4-cli.exe), per user.
; Built by CI: ISCC /DAppVersion=<version> installer\fc2mp4.iss, with both exes in build\installer\.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Never change AppId: it is how a new setup finds and updates an existing install.
AppId={{2F6C3B7E-9A41-4C55-8E2D-6B1F0C9D4A17}
AppName=fc2mp4
AppVersion={#AppVersion}
AppVerName=fc2mp4 {#AppVersion}
AppPublisher=Coccis
AppPublisherURL=https://github.com/Coccis77/fightcade-replay-converter
AppSupportURL=https://github.com/Coccis77/fightcade-replay-converter/issues
DefaultDirName={localappdata}\Programs\fc2mp4
UsePreviousAppDir=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\build
OutputBaseFilename=fc2mp4-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\fc2mp4.exe
UninstallDisplayName=fc2mp4

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\build\installer\fc2mp4.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\installer\fc2mp4-cli.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\fc2mp4"; Filename: "{app}\fc2mp4.exe"
Name: "{autodesktop}\fc2mp4"; Filename: "{app}\fc2mp4.exe"; Tasks: desktopicon

[Run]
; Also after a silent install, so "Update now" reopens the window. /nolaunch=1 (CI) skips it.
Filename: "{app}\fc2mp4.exe"; Description: "Launch fc2mp4"; Flags: nowait postinstall; Check: ShouldLaunch

[Code]
function ShouldLaunch: Boolean;
begin
  Result := ExpandConstant('{param:nolaunch|0}') = '0';
end;

function InstalledVersion: String;
begin
  if not RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{2F6C3B7E-9A41-4C55-8E2D-6B1F0C9D4A17}_is1', 'DisplayVersion', Result) then
    Result := '';
end;

function InitializeSetup: Boolean;
var
  Installed: String;
  InstalledPacked, NewPacked: Int64;
begin
  Result := True;
  Installed := InstalledVersion;
  if (Installed <> '') and StrToVersion(Installed, InstalledPacked) and StrToVersion('{#AppVersion}', NewPacked) then
    if ComparePackedVersion(InstalledPacked, NewPacked) > 0 then
      Result := SuppressibleMsgBox('A newer version of fc2mp4 is already installed (v' + Installed + '). Install v{#AppVersion} anyway?',
        mbConfirmation, MB_YESNO, IDNO) = IDYES;
end;

procedure InitializeWizard;
begin
  if InstalledVersion <> '' then
    WizardForm.Caption := 'Updating fc2mp4 to v{#AppVersion}';
end;
```

- [ ] **Step 2: CI (`.github/workflows/cli.yml`)**

- `build` matrix, Windows entry: `name: fc2mp4-cli.exe` (artifact `build/fc2mp4.exe` copied to that name).
- `ui` job: the build now outputs `ui/src/bin/Release/net48/fc2mp4.exe`; replace its copy/upload steps with:

```yaml
      - run: cp ui/src/bin/Release/net48/fc2mp4.exe fc2mp4.exe
      - uses: actions/upload-artifact@v4
        with:
          name: fc2mp4-window
          path: fc2mp4.exe
```

- New job after `ui`:

```yaml
  installer:
    needs: [build, ui]
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: fc2mp4-cli.exe
          path: build/installer
      - uses: actions/download-artifact@v4
        with:
          name: fc2mp4-window
          path: build/installer
      - name: Build the installer
        shell: pwsh
        run: |
          $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
          if (-not (Test-Path $iscc)) { choco install innosetup -y --no-progress }
          $version = node -p "require('./package.json').version"
          & $iscc "/DAppVersion=$version" installer\fc2mp4.iss
          if ($LASTEXITCODE -ne 0) { exit 1 }
      - name: Install, update and uninstall it
        shell: pwsh
        run: |
          $version = node -p "require('./package.json').version"
          $app = "$env:LOCALAPPDATA\Programs\fc2mp4"
          $silent = '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/nolaunch=1'
          Start-Process build\fc2mp4-setup.exe -ArgumentList $silent -Wait
          if (-not (Test-Path "$app\fc2mp4.exe") -or -not (Test-Path "$app\fc2mp4-cli.exe")) { throw 'files missing after install' }
          $printed = (& "$app\fc2mp4-cli.exe" --version | Out-String).Trim()
          if ($printed -ne $version) { throw "fc2mp4-cli.exe --version printed '$printed', expected $version" }
          Start-Process build\fc2mp4-setup.exe -ArgumentList $silent -Wait
          if (-not (Test-Path "$app\fc2mp4-cli.exe")) { throw 'files missing after update' }
          Start-Process "$app\unins000.exe" -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES' -Wait
          Start-Sleep -Seconds 5
          if (Test-Path "$app\fc2mp4-cli.exe") { throw 'still installed after uninstall' }
      - uses: actions/upload-artifact@v4
        with:
          name: fc2mp4-setup.exe
          path: build/fc2mp4-setup.exe
```

- `release` job: `needs: [build, image, ui, installer]`; files `fc2mp4-setup.exe fc2mp4-cli.exe fc2mp4-macos-arm64 fc2mp4-linux-x64`; notes:

```
Windows: download fc2mp4-setup.exe and run it (it updates itself afterwards). Command line: fc2mp4-cli.exe. macOS: fc2mp4-macos-arm64. Linux: fc2mp4-linux-x64. Docker: ghcr.io/coccis77/fc2mp4:${GITHUB_REF_NAME#v} (see README). Unsigned: Windows SmartScreen may ask you to confirm (More info → Run anyway).
```

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/cli.yml"); puts "yaml ok"'` — Expected: `yaml ok`.

- [ ] **Step 3: README**

- Install, Windows bullet becomes:

```markdown
- **Windows:** download `fc2mp4-setup.exe` from the latest release on the
  [releases page](https://github.com/Coccis77/fightcade-replay-converter/releases) and run it. Windows may
  warn that it is unsigned: click *More info* → *Run anyway*. It installs for your Windows account (no
  administrator rights), adds fc2mp4 to the Start menu, and offers each new version when you open it.
  ffmpeg and the emulator are downloaded on the first conversion.
```

- `### Windows` section: replace the "**The easy way:** …" paragraph (through "…links to the download page.") with:

```markdown
Open **fc2mp4** from the Start menu. Paste one or more replay links (one per line) and press
**Convert**: the links are converted one after the other, the console shows the progress, and
**Open video** opens the last one. If the window is in the background, Windows tells you when it is
done. The folders (Fightcade, videos) and the encoder are under **Settings** and are remembered; leave
*Fightcade folder* empty unless fc2mp4 does not find Fightcade by itself. When a new version is out, a
bar at the top offers to update.

Coming from the two files `fc2mp4.exe` + `fc2mp4-ui.exe`: run the installer, then delete them; your
settings are kept.
```

- "**From PowerShell:**" part: replace the open-PowerShell paragraph and the three `.\fc2mp4.exe` examples with the installed tool:

```markdown
The installer also puts the command-line tool, `fc2mp4-cli.exe`, next to the window (the release page
offers it on its own too):

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234"
```
```

  and in the `--fightcade-dir` and `-o` examples replace `.\fc2mp4.exe` with `& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe"`; the sentence "PowerShell needs the `.\` in front of `fc2mp4.exe`, and the link in quotes." becomes "Keep the `&` and the quotes."

- [ ] **Step 4: Run all checks**

Run: `npm test && npm run typecheck && dotnet test ui/tests/Fc2mp4Ui.Tests.csproj -nologo && dotnet build ui/src/Fc2mp4Ui.csproj -c Release -nologo`
Expected: PASS / build succeeds.

- [ ] **Step 5: Commit**

```bash
git add installer .github/workflows/cli.yml README.md
git commit -m "feat: Windows installer (fc2mp4-setup.exe) built and smoke-tested in CI; release assets; README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Windows checks and release v0.18.0

Needs the user (Windows) and pushes: ask before each push.

- [ ] **Step 1: Push the branch (ask first)** and wait for its `cli` run: the `installer` job must pass (it installs, updates and uninstalls on the runner). Its `fc2mp4-setup.exe` artifact is the build to test.

- [ ] **Step 2: User checks with the branch build (version 0.17.0 in package.json, so GitHub's v0.17.0 is not newer: no bar):**
  1. Run `fc2mp4-setup.exe`: SmartScreen once; Start menu "fc2mp4"; "Installed apps" lists fc2mp4.
  2. The window opens from the Start menu; no exe path in Settings; version line "Version: v0.17.0".
  3. Paste 3 links (one broken, e.g. `https://replay.fightcade.com/fbneo/garou/1-1`), Convert, switch to another window: notification and flashing taskbar at the end; status "2 done, 1 failed (see the console)"; the box keeps only the broken link.
  4. Convert 2 links and Cancel during the first: "Cancelled after 0 of 2", both links stay, no notification.
  5. Run the same `fc2mp4-setup.exe` again: it says "Updating fc2mp4 …", installs in place, settings kept.

- [ ] **Step 3: Update failure path (before release):** a branch build with `package.json` set to `0.16.9` (commit on the branch only, reverted afterwards) installed over → the window offers v0.17.0 → Update now fails (v0.17.0 has no `fc2mp4-setup.exe`) → "The update couldn't be downloaded…" with [Try again] [Download from GitHub]; the old version keeps working.

- [ ] **Step 4: Merge and release (ask first):** revert the 0.16.9 commit, fast-forward `main`, `npm version 0.18.0 --no-git-tag-version`, commit `chore: v0.18.0`, tag `v0.18.0`, push; confirm the release lists `fc2mp4-setup.exe`, `fc2mp4-cli.exe`, `fc2mp4-macos-arm64`, `fc2mp4-linux-x64`.

- [ ] **Step 5: Update success path (after release):** install the 0.16.9 test build again → the window offers v0.18.0 → Update now → the window closes, comes back on v0.18.0 with "Updated to v0.18.0" and the settings kept.
