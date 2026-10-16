# fc2mp4-ui.exe (Windows window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small Windows app, `fc2mp4-ui.exe`, that runs an existing `fc2mp4.exe` with a pasted replay link and remembered folders, shows its output, and can stop it cleanly.

**Architecture:** fc2mp4 gains `--stop-on-stdin-close` (closing its stdin = first Ctrl-C). The window is C# WinForms on .NET Framework 4.8 in `ui/`: pure logic classes in `ui/src/Core/` (argument quoting, command, output log, outcome, settings, version check, output folder) are compiled both into the app and into a .NET 10 xUnit test project; the form and the process runner sit on top. CI builds and tests it on Linux (reference assemblies, no Windows SDK needed) and attaches it to each `v*` release.

**Tech Stack:** TypeScript/Node (fc2mp4, vitest); C# 12 syntax, .NET Framework 4.8 WinForms via `Microsoft.NETFramework.ReferenceAssemblies` 1.0.3; .NET 10 SDK; xUnit 2.9; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-windows-ui-design.md`

## Global Constraints

- App name `fc2mp4-ui.exe`, window title `fc2mp4`; target `net48`, no extra runtime or installer.
- Layout top to bottom: Replay link, Convert/Cancel, status line, console, Open video/Open folder, Settings group (fc2mp4.exe, Fightcade folder, Output folder, help line).
- Help line text: `Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).`
- Settings file `%APPDATA%\fc2mp4-ui\settings.txt`, `key=value` lines (`exe`, `fightcade`, `output`); link never saved. Saved when a conversion starts and when the window closes.
- Defaults: exe = `fc2mp4.exe` next to `fc2mp4-ui.exe` if present; output = `%USERPROFILE%\Videos\Fightcade`; Fightcade folder empty = found automatically.
- Command: `fc2mp4.exe <link> -o <output folder> [--fightcade-dir <folder>] --stop-on-stdin-close`, no console window, UTF-8 output.
- Exit 0 → `Done: <path>`; 130 → `Cancelled`; forced kill → `Cancelled (forced)`; other → `Failed: <last Hint text, else last Error text, else "fc2mp4 stopped (exit N)">`.
- Cancel: close stdin, wait 30 s, then kill the process tree.
- Version check: `fc2mp4.exe --version` (5 s); lower than the window's → not ready: `This fc2mp4.exe is too old for this window (vX): download the latest one`; unreadable → warning, Convert allowed; window version 0.0.0 (local build) → no check.
- Released in the same `v*` releases as `fc2mp4.exe`, same version; first release v0.15.0.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A successful conversion while the window still holds fc2mp4's stdin open: fc2mp4 must still exit (no hang) — Task 1 real-process test.
2. Paths with spaces, a trailing `\`, or quotes in any field must reach fc2mp4 unchanged — Task 2 round-trip test against the Windows parsing rules.
3. A link pasted with spaces or a trailing newline must work — Task 2 test.
4. An output folder that cannot be created must fail clearly before fc2mp4 starts — Task 4 test.
5. A forced kill (exit code 1 from taskkill) must read "Cancelled (forced)", not "Failed"; a `Hint:` from an early warning must not mask the final error's hint — Task 3 tests.

---

### Task 1: fc2mp4 `--stop-on-stdin-close`

**Files:**
- Modify: `src/signals.ts` (add `stopOnStdinClose`)
- Modify: `src/cliArgs.ts:13-27` (USAGE line), `:32-38` (type), `:63-80` (option), convert return, command check
- Modify: `src/cli.ts` (wire it, dispose in `finally`)
- Create: `tests/fixtures/stdin-stop.ts`
- Test: `tests/signals.test.ts`, `tests/cliArgs.test.ts:33-53`

**Interfaces:**
- Produces: `stopOnStdinClose(stdin: EventEmitter & { resume(): unknown; destroy(): unknown }, controller: AbortController, write: (msg: string) => void): () => void` (returns a dispose function); `CliRequest` convert member gains `stopOnStdinClose: boolean`; CLI flag `--stop-on-stdin-close`.

- [ ] **Step 1: Write the failing tests**

Create `tests/fixtures/stdin-stop.ts`:

```ts
// Run by tests/signals.test.ts in a real child process: `watch` waits for stdin to close,
// `dispose` stops watching at once (as fc2mp4 does after a conversion) and must let the process exit.
import { stopOnStdinClose } from '../../src/signals.js';

const controller = new AbortController();
const dispose = stopOnStdinClose(process.stdin, controller, (msg) => process.stderr.write(msg));
if (process.argv[2] === 'dispose') {
  dispose();
  process.stdout.write('disposed\n');
} else {
  controller.signal.addEventListener('abort', () => {
    process.stdout.write('aborted\n');
    dispose();
  });
}
```

Append to `tests/signals.test.ts` (merge the imports at the top of the file):

```ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stopOnStdinClose } from '../src/signals.js';

function fakeStdin() {
  const stdin = Object.assign(new EventEmitter(), { resumed: false, destroyed: false, resume() { this.resumed = true; }, destroy() { this.destroyed = true; } });
  return stdin;
}

describe('stopOnStdinClose', () => {
  it('stops like the first Ctrl-C when stdin ends, once', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    const written: string[] = [];
    stopOnStdinClose(stdin, controller, (m) => written.push(m));
    expect(stdin.resumed).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    stdin.emit('end');
    stdin.emit('close');
    expect(controller.signal.aborted).toBe(true);
    expect(written).toEqual(['\nStopping…\n']);
  });

  it('stops when stdin fails too', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    stopOnStdinClose(stdin, controller, () => {});
    stdin.emit('error', new Error('EPIPE'));
    expect(controller.signal.aborted).toBe(true);
  });

  it('ignores stdin once disposed, and releases it', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    const dispose = stopOnStdinClose(stdin, controller, () => {});
    dispose();
    stdin.emit('end');
    expect(controller.signal.aborted).toBe(false);
    expect(stdin.destroyed).toBe(true);
  });
});

describe('stopOnStdinClose in a real process', () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'stdin-stop.ts');
  function run(mode: string, closeStdin: boolean) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`still running after 15 s (stdout: ${stdout})`));
      }, 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (closeStdin) child.stdin.end();
    });
  }

  it('stops when the parent closes stdin', async () => {
    const result = await run('watch', true);
    expect(result).toMatchObject({ code: 0, stdout: 'aborted\n' });
    expect(result.stderr).toContain('Stopping…');
  }, 20_000);

  it('exits on its own once disposed, although the parent keeps stdin open', async () => {
    await expect(run('dispose', false)).resolves.toMatchObject({ code: 0, stdout: 'disposed\n' });
  }, 20_000);
});
```

In `tests/cliArgs.test.ts`, add `stopOnStdinClose: false,` to the two convert expectations (`'applies defaults'` and the one with `-o /tmp/x.mp4`), and add inside `describe('parseCli', …)`:

```ts
  it('reads --stop-on-stdin-close for a conversion only', () => {
    expect(parseCli(['1-2', '--stop-on-stdin-close'])).toMatchObject({ command: 'convert', stopOnStdinClose: true });
    expect(usageError(['serve', '--stop-on-stdin-close'])).toMatchObject({ exitCode: ExitCode.Usage, message: '--stop-on-stdin-close only works when converting a replay' });
    expect(usageError(['prepare', '--stop-on-stdin-close'])).toMatchObject({ exitCode: ExitCode.Usage });
  });

  it('documents --stop-on-stdin-close', () => {
    expect(USAGE).toContain('--stop-on-stdin-close Stop cleanly when standard input closes (for programs that run fc2mp4)');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/signals.test.ts tests/cliArgs.test.ts`
Expected: FAIL — `stopOnStdinClose` not exported, unknown option `--stop-on-stdin-close`.

- [ ] **Step 3: Implement**

Append to `src/signals.ts`:

```ts
// fc2mp4-ui.exe cannot send Ctrl-C on Windows: it closes our stdin instead (a crashed window closes it
// too). Same as the first Ctrl-C. The returned function stops watching and releases stdin, so the
// process can exit after a conversion although the window still holds the pipe open.
export function stopOnStdinClose(
  stdin: EventEmitter & { resume(): unknown; destroy(): unknown },
  controller: AbortController,
  write: (msg: string) => void,
): () => void {
  const stop = () => {
    if (controller.signal.aborted) return;
    write('\nStopping…\n');
    controller.abort();
  };
  stdin.on('end', stop);
  stdin.on('close', stop);
  stdin.on('error', stop);
  stdin.resume();
  return () => {
    stdin.off('end', stop);
    stdin.off('close', stop);
    stdin.off('error', stop);
    stdin.destroy();
  };
}
```

`src/cliArgs.ts`:
- In `USAGE`, after the `--fightcade-dir` option's two lines, add:

```
      --stop-on-stdin-close Stop cleanly when standard input closes (for programs that run fc2mp4)
```

- Convert member of `CliRequest`: add `stopOnStdinClose: boolean;` after `fightcadeDir?: string;`.
- `parseArgs` options: add `'stop-on-stdin-close': { type: 'boolean' },`.
- Right after `const command = positionals[0];` add:

```ts
  const nonConvert = ['reset-admin', 'prepare', 'serve', 'update-emulator', 'rebuild-emulator'];
  if (values['stop-on-stdin-close'] && command !== undefined && nonConvert.includes(command)) {
    throw usage('--stop-on-stdin-close only works when converting a replay');
  }
```

- In the convert return object, add `stopOnStdinClose: values['stop-on-stdin-close'] ?? false,` after `fightcadeDir`.

`src/cli.ts`:
- Import: `import { installSignalHandlers, stopOnStdinClose } from './signals.js';`
- At the start of `main()`, after `installSignalHandlers(…)`: `let stopWatchingStdin = () => {};`
- Just before `const result = await convert(request.input, {`:

```ts
    if (request.stopOnStdinClose) stopWatchingStdin = stopOnStdinClose(process.stdin, controller, (msg) => process.stderr.write(msg));
```

- Add a `finally` to `main()`'s `try { … } catch (err) { … }`:

```ts
  } finally {
    stopWatchingStdin();
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/signals.test.ts tests/cliArgs.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/signals.ts src/cliArgs.ts src/cli.ts tests/signals.test.ts tests/cliArgs.test.ts tests/fixtures/stdin-stop.ts
git commit -m "feat: --stop-on-stdin-close, so a window can stop fc2mp4 cleanly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: UI projects, argument quoting and the fc2mp4 command

**Files:**
- Create: `ui/src/Fc2mp4Ui.csproj`, `ui/src/Program.cs` (placeholder form, replaced in Task 5)
- Create: `ui/src/Core/WindowsArgs.cs`, `ui/src/Core/Fc2mp4Command.cs`
- Create: `ui/tests/Fc2mp4Ui.Tests.csproj`, `ui/tests/WindowsArgsTests.cs`, `ui/tests/Fc2mp4CommandTests.cs`
- Modify: `.gitignore` (add `bin/`, `obj/`)

**Interfaces:**
- Produces: `static class WindowsArgs { string Quote(string arg); string Join(IEnumerable<string> args); }`; `static class Fc2mp4Command { List<string> Arguments(string link, string outputFolder, string fightcadeFolder); }` (namespace `Fc2mp4Ui`).

- [ ] **Step 1: Create the projects and failing tests**

`ui/src/Fc2mp4Ui.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net48</TargetFramework>
    <LangVersion>12</LangVersion>
    <AssemblyName>fc2mp4-ui</AssemblyName>
    <RootNamespace>Fc2mp4Ui</RootNamespace>
    <!-- CI passes -p:Version=<package.json version>; 0.0.0 marks a local build (no version check). -->
    <Version>0.0.0</Version>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
  </PropertyGroup>
  <ItemGroup>
    <!-- Builds the .NET Framework app on any OS, without the Windows desktop SDK. -->
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
    <Reference Include="System.Windows.Forms" />
    <Reference Include="System.Drawing" />
  </ItemGroup>
</Project>
```

`ui/src/Program.cs` (temporary, so the app project builds in this task):

```csharp
using System;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.Run(new Form { Text = "fc2mp4" });
        }
    }
}
```

`ui/tests/Fc2mp4Ui.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <LangVersion>12</LangVersion>
    <IsPackable>false</IsPackable>
    <RootNamespace>Fc2mp4Ui.Tests</RootNamespace>
  </PropertyGroup>
  <ItemGroup>
    <!-- The same logic files the app compiles: no WinForms in them. -->
    <Compile Include="../src/Core/**/*.cs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>
```

`ui/tests/WindowsArgsTests.cs`:

```csharp
using System.Collections.Generic;
using System.Text;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class WindowsArgsTests
    {
        [Theory]
        [InlineData("plain", "plain")]
        [InlineData(@"C:\Fightcade", @"C:\Fightcade")]
        [InlineData("", "\"\"")]
        [InlineData(@"C:\My Games\Fightcade", "\"C:\\My Games\\Fightcade\"")]
        [InlineData(@"C:\My Games\Fightcade\", "\"C:\\My Games\\Fightcade\\\\\"")]
        [InlineData("a\"b", "\"a\\\"b\"")]
        public void QuotesOnlyWhenNeeded(string arg, string expected)
        {
            Assert.Equal(expected, WindowsArgs.Quote(arg));
        }

        // What the program receives must be exactly what we meant to send (Microsoft C runtime rules,
        // which Node.js follows on Windows).
        [Fact]
        public void RoundTripsThroughTheWindowsParsingRules()
        {
            var args = new List<string>
            {
                "https://replay.fightcade.com/fbneo/garou/1791766846976-7757",
                "-o", @"C:\Users\Jean Pierre\Videos\Fightcade\",
                "--fightcade-dir", @"D:\Games\Fight cade\",
                "with \"quotes\" inside", @"back\\slashes\", "", "tab\there",
            };
            Assert.Equal(args, Parse(WindowsArgs.Join(args)));
        }

        static List<string> Parse(string commandLine)
        {
            var result = new List<string>();
            var current = new StringBuilder();
            bool inQuotes = false, inArg = false;
            for (int i = 0; i < commandLine.Length; i++)
            {
                char c = commandLine[i];
                if (c == '\\')
                {
                    int n = 0;
                    while (i < commandLine.Length && commandLine[i] == '\\') { n++; i++; }
                    if (i < commandLine.Length && commandLine[i] == '"')
                    {
                        current.Append('\\', n / 2);
                        if (n % 2 == 1) current.Append('"');
                        else { inQuotes = !inQuotes; }
                    }
                    else { current.Append('\\', n); i--; }
                    inArg = true;
                }
                else if (c == '"') { inQuotes = !inQuotes; inArg = true; }
                else if ((c == ' ' || c == '\t') && !inQuotes)
                {
                    if (inArg) { result.Add(current.ToString()); current.Clear(); inArg = false; }
                }
                else { current.Append(c); inArg = true; }
            }
            if (inArg) result.Add(current.ToString());
            return result;
        }
    }
}
```

`ui/tests/Fc2mp4CommandTests.cs`:

```csharp
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class Fc2mp4CommandTests
    {
        [Fact]
        public void PassesTheLinkTheOutputFolderAndTheStopOption()
        {
            Assert.Equal(
                new[] { "https://replay.fightcade.com/fbneo/sfa3/1-2", "-o", @"C:\Videos", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("https://replay.fightcade.com/fbneo/sfa3/1-2", @"C:\Videos", ""));
        }

        [Fact]
        public void AddsTheFightcadeFolderOnlyWhenSet()
        {
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--fightcade-dir", @"D:\Fightcade", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", @"D:\Fightcade"));
            Assert.DoesNotContain("--fightcade-dir", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "   "));
        }

        [Fact]
        public void TrimsWhatWasPasted()
        {
            Assert.Equal("https://replay.fightcade.com/fbneo/garou/1-2",
                Fc2mp4Command.Arguments("  https://replay.fightcade.com/fbneo/garou/1-2\r\n", @"C:\V", "")[0]);
            Assert.Equal(@"D:\Fightcade", Fc2mp4Command.Arguments("1-2", @"C:\V", @" D:\Fightcade ")[4]);
        }
    }
}
```

`.gitignore`: append the two lines `bin/` and `obj/`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj`
Expected: FAIL to compile — `WindowsArgs` and `Fc2mp4Command` do not exist.

- [ ] **Step 3: Implement**

`ui/src/Core/WindowsArgs.cs`:

```csharp
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Fc2mp4Ui
{
    // Builds a Windows command line that the program receives exactly as given (Microsoft C runtime
    // rules, also used by Node.js): paths with spaces, a trailing backslash or quotes stay intact.
    public static class WindowsArgs
    {
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') sb.Append('\\', backslashes * 2 + 1);
                else sb.Append('\\', backslashes);
                sb.Append(c);
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string Join(IEnumerable<string> args) => string.Join(" ", args.Select(Quote));
    }
}
```

`ui/src/Core/Fc2mp4Command.cs`:

```csharp
using System.Collections.Generic;

namespace Fc2mp4Ui
{
    public static class Fc2mp4Command
    {
        // fc2mp4.exe <link> -o <output folder> [--fightcade-dir <folder>] --stop-on-stdin-close
        public static List<string> Arguments(string link, string outputFolder, string fightcadeFolder)
        {
            var args = new List<string> { link.Trim(), "-o", outputFolder.Trim() };
            if (!string.IsNullOrWhiteSpace(fightcadeFolder))
            {
                args.Add("--fightcade-dir");
                args.Add(fightcadeFolder.Trim());
            }
            args.Add("--stop-on-stdin-close");
            return args;
        }
    }
}
```

- [ ] **Step 4: Run the tests and build the app**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj && dotnet build ui/src/Fc2mp4Ui.csproj -c Release && ls ui/src/bin/Release/net48/fc2mp4-ui.exe`
Expected: tests PASS; build succeeds; the exe exists.

- [ ] **Step 5: Commit**

```bash
git add ui .gitignore
git commit -m "feat(ui): projects, Windows argument quoting and the fc2mp4 command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Output log and run outcome

**Files:**
- Create: `ui/src/Core/OutputLog.cs`, `ui/src/Core/RunOutcome.cs`
- Test: `ui/tests/OutputLogTests.cs`, `ui/tests/RunOutcomeTests.cs`

**Interfaces:**
- Produces: `sealed class OutputLog { IReadOnlyList<string> Lines; string Progress; void Add(string line); string Text; }`; `enum OutcomeKind { Done, Cancelled, Failed }`; `sealed class RunOutcome { OutcomeKind Kind; string Message; string VideoPath; static RunOutcome From(int exitCode, bool forced, IReadOnlyList<string> stdout, IReadOnlyList<string> stderr); }`.

- [ ] **Step 1: Write the failing tests**

`ui/tests/OutputLogTests.cs`:

```csharp
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class OutputLogTests
    {
        [Fact]
        public void KeepsLinesAndUpdatesTheProgressLineInPlace()
        {
            var log = new OutputLog();
            log.Add("Preparing ffmpeg and the emulator (the first run downloads them)…");
            log.Add("Connecting to the replay stream…");
            log.Add("Capturing… 1s of replay (60 frames, ×1.0)");
            log.Add("Capturing… 2s of replay (120 frames, ×2.0)");
            Assert.Equal(new[]
            {
                "Preparing ffmpeg and the emulator (the first run downloads them)…",
                "Connecting to the replay stream…",
                "Capturing… 2s of replay (120 frames, ×2.0)",
            }, log.Lines);
            Assert.Equal("Capturing… 2s of replay (120 frames, ×2.0)", log.Progress);
            log.Add("Finalizing the MP4…");
            log.Add("Captured 0:02 of replay.");
            Assert.Equal(5, log.Lines.Count);
        }

        [Fact]
        public void SkipsBlankLinesAndNulls()
        {
            var log = new OutputLog();
            log.Add("");
            log.Add(null);
            log.Add("   ");
            log.Add("Stopping…");
            Assert.Equal(new[] { "Stopping…" }, log.Lines);
            Assert.Null(log.Progress);
        }

        [Fact]
        public void JoinsLinesForTheConsole()
        {
            var log = new OutputLog();
            log.Add("a");
            log.Add("b");
            Assert.Equal("a" + System.Environment.NewLine + "b", log.Text);
        }
    }
}
```

`ui/tests/RunOutcomeTests.cs`:

```csharp
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class RunOutcomeTests
    {
        [Fact]
        public void DoneWithTheVideoPathFromTheLastStdoutLine()
        {
            var o = RunOutcome.From(0, false, new[] { "", @"C:\Videos\1-2.mp4", "" }, new string[0]);
            Assert.Equal(OutcomeKind.Done, o.Kind);
            Assert.Equal(@"C:\Videos\1-2.mp4", o.VideoPath);
            Assert.Equal(@"Done: C:\Videos\1-2.mp4", o.Message);
        }

        [Fact]
        public void CancelledOnExit130_AndForcedWhateverTheCode()
        {
            Assert.Equal("Cancelled", RunOutcome.From(130, false, new string[0], new string[0]).Message);
            var forced = RunOutcome.From(1, true, new string[0], new[] { "Error: whatever" });
            Assert.Equal(OutcomeKind.Cancelled, forced.Kind);
            Assert.Equal("Cancelled (forced)", forced.Message);
        }

        [Fact]
        public void FailedShowsTheLastHint_ElseTheLastError_ElseTheExitCode()
        {
            var stderr = new[]
            {
                "Hint: an earlier hint from a warning",
                "Error: Garou: Mark of the Wolves ROM not found: C:\\F\\ROMs\\neogeo.zip",
                "Hint: Open Garou once in Fightcade so it downloads the ROM",
            };
            var o = RunOutcome.From(3, false, new string[0], stderr);
            Assert.Equal(OutcomeKind.Failed, o.Kind);
            Assert.Equal("Failed: Open Garou once in Fightcade so it downloads the ROM", o.Message);
            Assert.Null(o.VideoPath);

            Assert.Equal("Failed: Fightcade install not found",
                RunOutcome.From(3, false, new string[0], new[] { "Error: Fightcade install not found" }).Message);
            Assert.Equal("Failed: fc2mp4 stopped (exit 7)", RunOutcome.From(7, false, new string[0], new string[0]).Message);
        }

        [Fact]
        public void TheFinalErrorsHintWinsOverAnEarlierOne()
        {
            var stderr = new[] { "Hint: early", "Error: late failure" };
            Assert.Equal("Failed: late failure", RunOutcome.From(6, false, new string[0], stderr).Message);
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj`
Expected: FAIL to compile — `OutputLog`, `RunOutcome`, `OutcomeKind` missing.

- [ ] **Step 3: Implement**

`ui/src/Core/OutputLog.cs`:

```csharp
using System;
using System.Collections.Generic;

namespace Fc2mp4Ui
{
    // fc2mp4's stderr for the console: its "Capturing…" progress line is repeated every half second,
    // so a new one replaces the previous one instead of filling the console.
    public sealed class OutputLog
    {
        const string ProgressPrefix = "Capturing…";
        readonly List<string> lines = new List<string>();

        public IReadOnlyList<string> Lines => lines;
        public string Progress { get; private set; }
        public string Text => string.Join(Environment.NewLine, lines);

        public void Add(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            bool progress = line.StartsWith(ProgressPrefix, StringComparison.Ordinal);
            if (progress) Progress = line;
            if (progress && lines.Count > 0 && lines[lines.Count - 1].StartsWith(ProgressPrefix, StringComparison.Ordinal))
                lines[lines.Count - 1] = line;
            else
                lines.Add(line);
        }
    }
}
```

`ui/src/Core/RunOutcome.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Linq;

namespace Fc2mp4Ui
{
    public enum OutcomeKind { Done, Cancelled, Failed }

    public sealed class RunOutcome
    {
        public OutcomeKind Kind { get; private set; }
        public string Message { get; private set; }
        public string VideoPath { get; private set; }

        // fc2mp4 prints the video path as its last stdout line on success, and "Error: …" then
        // optionally "Hint: …" on stderr when it fails; 130 means it stopped as asked.
        public static RunOutcome From(int exitCode, bool forced, IReadOnlyList<string> stdout, IReadOnlyList<string> stderr)
        {
            if (forced) return new RunOutcome { Kind = OutcomeKind.Cancelled, Message = "Cancelled (forced)" };
            if (exitCode == 0)
            {
                string path = stdout.LastOrDefault(l => !string.IsNullOrWhiteSpace(l))?.Trim();
                return new RunOutcome { Kind = OutcomeKind.Done, VideoPath = path, Message = path == null ? "Done" : "Done: " + path };
            }
            if (exitCode == 130) return new RunOutcome { Kind = OutcomeKind.Cancelled, Message = "Cancelled" };
            return new RunOutcome { Kind = OutcomeKind.Failed, Message = "Failed: " + FailureText(exitCode, stderr) };
        }

        static string FailureText(int exitCode, IReadOnlyList<string> stderr)
        {
            int lastError = LastIndex(stderr, "Error: ");
            int lastHint = LastIndex(stderr, "Hint: ");
            // A hint belongs to the error just before it; an older hint (from a warning) does not count.
            if (lastHint > lastError && lastError >= 0) return stderr[lastHint].Substring("Hint: ".Length).Trim();
            if (lastError >= 0) return stderr[lastError].Substring("Error: ".Length).Trim();
            if (lastHint >= 0) return stderr[lastHint].Substring("Hint: ".Length).Trim();
            return "fc2mp4 stopped (exit " + exitCode + ")";
        }

        static int LastIndex(IReadOnlyList<string> lines, string prefix)
        {
            for (int i = lines.Count - 1; i >= 0; i--)
                if (lines[i] != null && lines[i].StartsWith(prefix, StringComparison.Ordinal)) return i;
            return -1;
        }
    }
}
```

- [ ] **Step 4: Run the tests and build**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj && dotnet build ui/src/Fc2mp4Ui.csproj -c Release`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): console log with in-place progress, and the run outcome

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Settings, version check and output folder

**Files:**
- Create: `ui/src/Core/Settings.cs`, `ui/src/Core/VersionCheck.cs`, `ui/src/Core/OutputFolder.cs`
- Test: `ui/tests/SettingsTests.cs`, `ui/tests/VersionCheckTests.cs`, `ui/tests/OutputFolderTests.cs`

**Interfaces:**
- Produces: `sealed class Settings { string Exe; string FightcadeFolder; string OutputFolder; static Settings Load(string path, string defaultExe, string defaultOutput); void Save(string path); }`; `enum VersionStatus { Ok, TooOld, Unknown }`; `sealed class VersionVerdict { VersionStatus Status; string Message; }`; `static class VersionCheck { VersionVerdict Evaluate(Version window, string exeOutput); }`; `static class OutputFolder { string Ensure(string folder); }` (returns null when ready, else an error message).

- [ ] **Step 1: Write the failing tests**

`ui/tests/SettingsTests.cs`:

```csharp
using System.IO;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class SettingsTests
    {
        static string TempFile() => Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName(), "settings.txt");

        [Fact]
        public void UsesTheDefaultsWithoutAFile()
        {
            var s = Settings.Load(TempFile(), @"C:\Tools\fc2mp4.exe", @"C:\Videos\Fightcade");
            Assert.Equal(@"C:\Tools\fc2mp4.exe", s.Exe);
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal(@"C:\Videos\Fightcade", s.OutputFolder);
        }

        [Fact]
        public void SavesAndLoadsBack_CreatingTheFolder_EvenWithEqualsSignsInPaths()
        {
            string path = TempFile();
            new Settings { Exe = @"C:\a=b\fc2mp4.exe", FightcadeFolder = @"D:\Fight cade", OutputFolder = @"E:\Out" }.Save(path);
            var s = Settings.Load(path, "x", "y");
            Assert.Equal(@"C:\a=b\fc2mp4.exe", s.Exe);
            Assert.Equal(@"D:\Fight cade", s.FightcadeFolder);
            Assert.Equal(@"E:\Out", s.OutputFolder);
        }

        [Fact]
        public void EmptyExeOrOutputFallBackToTheDefaults_EmptyFightcadeStaysEmpty()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=\nfightcade=\noutput=\nunknown=1\ngarbage line\n");
            var s = Settings.Load(path, "defExe", "defOut");
            Assert.Equal("defExe", s.Exe);
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal("defOut", s.OutputFolder);
        }

        [Fact]
        public void AnUnreadableFileMeansDefaults()
        {
            string dir = Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir); // a folder where the file should be
            var s = Settings.Load(dir, "defExe", "defOut");
            Assert.Equal("defExe", s.Exe);
        }
    }
}
```

`ui/tests/VersionCheckTests.cs`:

```csharp
using System;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class VersionCheckTests
    {
        static readonly Version Window = new Version(0, 15, 0, 0);

        [Theory]
        [InlineData("0.15.0\n")]
        [InlineData("0.16.2")]
        [InlineData("v1.0.0")]
        public void AcceptsTheSameOrNewer(string output)
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(Window, output).Status);
        }

        [Fact]
        public void RefusesAnOlderExeWithTheMessage()
        {
            var v = VersionCheck.Evaluate(Window, "0.14.0\r\n");
            Assert.Equal(VersionStatus.TooOld, v.Status);
            Assert.Equal("This fc2mp4.exe is too old for this window (v0.14.0): download the latest one", v.Message);
        }

        [Theory]
        [InlineData("dev")]
        [InlineData("")]
        [InlineData(null)]
        [InlineData("Usage: fc2mp4 …")]
        public void WarnsWhenTheVersionCannotBeRead(string output)
        {
            var v = VersionCheck.Evaluate(Window, output);
            Assert.Equal(VersionStatus.Unknown, v.Status);
            Assert.Equal("Could not read this fc2mp4.exe's version; it may not work with this window", v.Message);
        }

        [Fact]
        public void ALocalWindowBuildChecksNothing()
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(new Version(0, 0, 0, 0), "0.1.0").Status);
        }

        [Fact]
        public void APrereleaseCountsAsItsVersion()
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(Window, "0.15.0-rc1").Status);
        }
    }
}
```

`ui/tests/OutputFolderTests.cs`:

```csharp
using System.IO;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class OutputFolderTests
    {
        [Fact]
        public void CreatesAMissingFolder()
        {
            string dir = Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName(), "Videos", "Fightcade");
            Assert.Null(OutputFolder.Ensure(dir));
            Assert.True(Directory.Exists(dir));
        }

        [Fact]
        public void ExplainsAFolderThatCannotBeCreated()
        {
            string file = Path.GetTempFileName(); // a file: nothing can be created inside it
            string error = OutputFolder.Ensure(Path.Combine(file, "sub"));
            Assert.StartsWith("Cannot create the output folder " + Path.Combine(file, "sub") + ": ", error);
        }

        [Fact]
        public void RefusesAnEmptyField()
        {
            Assert.Equal("Choose an output folder in Settings", OutputFolder.Ensure("  "));
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj`
Expected: FAIL to compile — `Settings`, `VersionCheck`, `VersionStatus`, `OutputFolder` missing.

- [ ] **Step 3: Implement**

`ui/src/Core/Settings.cs`:

```csharp
using System;
using System.IO;
using System.Text;

namespace Fc2mp4Ui
{
    // %APPDATA%\fc2mp4-ui\settings.txt: exe=, fightcade=, output= (the link is never saved).
    public sealed class Settings
    {
        public string Exe { get; set; } = "";
        public string FightcadeFolder { get; set; } = "";
        public string OutputFolder { get; set; } = "";

        public static Settings Load(string path, string defaultExe, string defaultOutput)
        {
            var s = new Settings { Exe = defaultExe, OutputFolder = defaultOutput };
            string[] lines;
            try { lines = File.ReadAllLines(path, Encoding.UTF8); }
            catch (Exception) { return s; }
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key == "exe" && value.Length > 0) s.Exe = value;
                else if (key == "fightcade") s.FightcadeFolder = value;
                else if (key == "output" && value.Length > 0) s.OutputFolder = value;
            }
            return s;
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=" + Exe + "\nfightcade=" + FightcadeFolder + "\noutput=" + OutputFolder + "\n", new UTF8Encoding(false));
        }
    }
}
```

`ui/src/Core/VersionCheck.cs`:

```csharp
using System;
using System.Text.RegularExpressions;

namespace Fc2mp4Ui
{
    public enum VersionStatus { Ok, TooOld, Unknown }

    public sealed class VersionVerdict
    {
        public VersionStatus Status { get; set; }
        public string Message { get; set; } = "";
    }

    // The window needs an fc2mp4.exe from the same release or newer (for --stop-on-stdin-close).
    public static class VersionCheck
    {
        static readonly Regex Semver = new Regex(@"^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$");

        public static VersionVerdict Evaluate(Version window, string exeOutput)
        {
            var mine = new Version(window.Major, window.Minor, Math.Max(window.Build, 0));
            if (mine == new Version(0, 0, 0)) return new VersionVerdict { Status = VersionStatus.Ok };
            Match m = Semver.Match((exeOutput ?? "").Trim());
            if (!m.Success)
                return new VersionVerdict { Status = VersionStatus.Unknown, Message = "Could not read this fc2mp4.exe's version; it may not work with this window" };
            var theirs = new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value));
            if (theirs < mine)
                return new VersionVerdict { Status = VersionStatus.TooOld, Message = "This fc2mp4.exe is too old for this window (v" + theirs + "): download the latest one" };
            return new VersionVerdict { Status = VersionStatus.Ok };
        }
    }
}
```

`ui/src/Core/OutputFolder.cs`:

```csharp
using System;
using System.IO;

namespace Fc2mp4Ui
{
    // Created before fc2mp4 runs: fc2mp4 reads a missing folder given without a trailing "\" as a file name.
    public static class OutputFolder
    {
        public static string Ensure(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder)) return "Choose an output folder in Settings";
            try
            {
                Directory.CreateDirectory(folder.Trim());
                return null;
            }
            catch (Exception e)
            {
                return "Cannot create the output folder " + folder.Trim() + ": " + e.Message;
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests and build**

Run: `dotnet test ui/tests/Fc2mp4Ui.Tests.csproj && dotnet build ui/src/Fc2mp4Ui.csproj -c Release`
Expected: PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): settings file, fc2mp4 version check, output folder creation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The process runner and the window

**Files:**
- Create: `ui/src/ConversionRunner.cs`, `ui/src/MainForm.cs`
- Modify: `ui/src/Program.cs` (run `MainForm`)

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `sealed class ConversionRunner { event Action<string> StdoutLine, StderrLine; event Action<int, bool> Exited; bool Running; void Start(string exe, IEnumerable<string> args); Task CancelAsync(); static string ReadVersion(string exe); }`; `MainForm : Form`.

These two files use WinForms and Windows processes: they are checked by building here and by the manual checks in Task 7, not by unit tests.

- [ ] **Step 1: Write `ui/src/ConversionRunner.cs`**

```csharp
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

namespace Fc2mp4Ui
{
    // Runs fc2mp4.exe without a console window. Cancel closes its stdin (fc2mp4 then stops like Ctrl-C,
    // thanks to --stop-on-stdin-close) and only kills the process tree if it is still running after 30 s.
    public sealed class ConversionRunner
    {
        Process process;
        bool forced;

        public event Action<string> StdoutLine;
        public event Action<string> StderrLine;
        public event Action<int, bool> Exited;

        public bool Running => process != null && !process.HasExited;

        public void Start(string exe, IEnumerable<string> args)
        {
            forced = false;
            var psi = new ProcessStartInfo(exe, WindowsArgs.Join(args))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = System.IO.Path.GetDirectoryName(exe),
            };
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.OutputDataReceived += (s, e) => { if (e.Data != null) StdoutLine?.Invoke(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) StderrLine?.Invoke(e.Data); };
            p.Exited += (s, e) =>
            {
                p.WaitForExit(); // waits for the last output lines too
                Exited?.Invoke(p.ExitCode, forced);
            };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            process = p;
        }

        public async Task CancelAsync()
        {
            var p = process;
            if (p == null || p.HasExited) return;
            try { p.StandardInput.Close(); } catch (Exception) { }
            bool exited = await Task.Run(() => p.WaitForExit(30_000));
            if (exited) return;
            forced = true;
            KillTree(p.Id);
        }

        static void KillTree(int pid)
        {
            try
            {
                using (var kill = Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F") { UseShellExecute = false, CreateNoWindow = true }))
                    kill?.WaitForExit(10_000);
            }
            catch (Exception) { }
        }

        // "fc2mp4.exe --version", or null when it cannot be run or takes longer than 5 s.
        public static string ReadVersion(string exe)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, StandardOutputEncoding = Encoding.UTF8 };
                using (var p = Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEndAsync();
                    if (!p.WaitForExit(5_000)) { try { p.Kill(); } catch (Exception) { } return null; }
                    return output.Result;
                }
            }
            catch (Exception) { return null; }
        }
    }
}
```

- [ ] **Step 2: Write `ui/src/MainForm.cs`**

```csharp
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    public sealed class MainForm : Form
    {
        const string HelpText = "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).";

        readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fc2mp4-ui", "settings.txt");
        readonly Version windowVersion = typeof(MainForm).Assembly.GetName().Version;
        readonly ConversionRunner runner = new ConversionRunner();

        readonly TextBox link = new TextBox { Dock = DockStyle.Fill };
        readonly Button convert = new Button { Text = "Convert", AutoSize = true };
        readonly Button cancel = new Button { Text = "Cancel", AutoSize = true, Enabled = false };
        readonly Label status = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
        readonly TextBox console = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font(FontFamily.GenericMonospace, 9f), BackColor = SystemColors.Window };
        readonly Button openVideo = new Button { Text = "Open video", AutoSize = true, Enabled = false };
        readonly Button openFolder = new Button { Text = "Open folder", AutoSize = true, Enabled = false };
        readonly TextBox exe = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox fightcade = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox output = new TextBox { Dock = DockStyle.Fill };

        OutputLog log = new OutputLog();
        List<string> stdout = new List<string>();
        List<string> stderr = new List<string>();
        bool exeReady;
        bool closeWhenStopped;
        string videoPath;

        public MainForm()
        {
            Text = "fc2mp4";
            MinimumSize = new Size(640, 480);
            Size = new Size(760, 560);
            StartPosition = FormStartPosition.CenterScreen;
            BuildLayout();

            string besideMe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fc2mp4.exe");
            string defaultOutput = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Videos", "Fightcade");
            var settings = Settings.Load(settingsPath, File.Exists(besideMe) ? besideMe : "", defaultOutput);
            exe.Text = settings.Exe;
            fightcade.Text = settings.FightcadeFolder;
            output.Text = settings.OutputFolder;

            AcceptButton = convert;
            link.TextChanged += (s, e) => UpdateButtons();
            exe.Leave += (s, e) => CheckExe();
            convert.Click += (s, e) => StartConversion();
            cancel.Click += async (s, e) => { status.Text = "Stopping…"; cancel.Enabled = false; await runner.CancelAsync(); };
            openVideo.Click += (s, e) => { if (videoPath != null) Process.Start(new ProcessStartInfo(videoPath) { UseShellExecute = true }); };
            openFolder.Click += (s, e) => { if (videoPath != null) Process.Start("explorer.exe", "/select," + WindowsArgs.Quote(videoPath)); };
            runner.StderrLine += line => BeginInvoke(new Action(() => OnStderr(line)));
            runner.StdoutLine += line => BeginInvoke(new Action(() => stdout.Add(line)));
            runner.Exited += (code, forced) => BeginInvoke(new Action(() => OnExited(code, forced)));
            Shown += (s, e) => { CheckExe(); link.Focus(); };
            FormClosing += OnClosing;
        }

        void BuildLayout()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10) };
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // link
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // buttons
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));   // status
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // console
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // open buttons
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // settings

            var linkRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            linkRow.Controls.Add(new Label { Text = "Replay link", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            linkRow.Controls.Add(link, 1, 0);
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
            AddPathRow(grid, 0, "fc2mp4.exe", exe, BrowseExe);
            AddPathRow(grid, 1, "Fightcade folder", fightcade, () => BrowseFolder(fightcade, "Fightcade folder (the one that contains emulator\\fbneo)"));
            AddPathRow(grid, 2, "Output folder", output, () => BrowseFolder(output, "Folder for the videos"));
            var help = new Label { Text = HelpText, AutoSize = true, MaximumSize = new Size(680, 0), ForeColor = SystemColors.GrayText, Padding = new Padding(0, 6, 0, 0) };
            grid.Controls.Add(help, 0, 3);
            grid.SetColumnSpan(help, 3);
            group.Controls.Add(grid);
            root.Controls.Add(group);

            Controls.Add(root);
        }

        static void AddPathRow(TableLayoutPanel grid, int row, string label, TextBox box, Action browse)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            grid.Controls.Add(box, 1, row);
            var button = new Button { Text = "Browse…", AutoSize = true };
            button.Click += (s, e) => browse();
            grid.Controls.Add(button, 2, row);
        }

        void BrowseExe()
        {
            using (var dialog = new OpenFileDialog { Filter = "fc2mp4.exe|fc2mp4.exe|Programs (*.exe)|*.exe", Title = "Choose fc2mp4.exe" })
            {
                if (File.Exists(exe.Text)) dialog.InitialDirectory = Path.GetDirectoryName(exe.Text);
                if (dialog.ShowDialog(this) == DialogResult.OK) { exe.Text = dialog.FileName; CheckExe(); }
            }
        }

        void BrowseFolder(TextBox box, string description)
        {
            using (var dialog = new FolderBrowserDialog { Description = description, SelectedPath = box.Text })
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
        }

        void CheckExe()
        {
            exeReady = false;
            if (!File.Exists(exe.Text.Trim())) { status.Text = "Choose fc2mp4.exe in Settings"; UpdateButtons(); return; }
            var verdict = VersionCheck.Evaluate(windowVersion, ConversionRunner.ReadVersion(exe.Text.Trim()));
            exeReady = verdict.Status != VersionStatus.TooOld;
            status.Text = verdict.Status == VersionStatus.Ok ? "Ready" : verdict.Message;
            UpdateButtons();
        }

        void UpdateButtons()
        {
            bool running = runner.Running;
            convert.Enabled = exeReady && !running && link.Text.Trim().Length > 0;
            cancel.Enabled = running;
            foreach (var box in new[] { link, exe, fightcade, output }) box.ReadOnly = running;
        }

        Settings CurrentSettings() => new Settings { Exe = exe.Text.Trim(), FightcadeFolder = fightcade.Text.Trim(), OutputFolder = output.Text.Trim() };

        void SaveSettings()
        {
            try { CurrentSettings().Save(settingsPath); } catch (Exception) { }
        }

        void StartConversion()
        {
            if (!convert.Enabled) return;
            string folderError = OutputFolder.Ensure(output.Text);
            if (folderError != null) { status.Text = "Failed: " + folderError; return; }
            SaveSettings();
            log = new OutputLog();
            stdout = new List<string>();
            stderr = new List<string>();
            videoPath = null;
            console.Text = "";
            openVideo.Enabled = openFolder.Enabled = false;
            try
            {
                runner.Start(exe.Text.Trim(), Fc2mp4Command.Arguments(link.Text, output.Text, fightcade.Text));
            }
            catch (Exception e)
            {
                status.Text = "Failed: could not start fc2mp4.exe: " + e.Message;
                return;
            }
            status.Text = "Starting…";
            UpdateButtons();
        }

        void OnStderr(string line)
        {
            stderr.Add(line);
            log.Add(line);
            console.Text = log.Text;
            console.SelectionStart = console.TextLength;
            console.ScrollToCaret();
            if (log.Progress != null && line == log.Progress) status.Text = line;
        }

        void OnExited(int code, bool forced)
        {
            var outcome = RunOutcome.From(code, forced, stdout, stderr);
            status.Text = outcome.Message;
            videoPath = outcome.Kind == OutcomeKind.Done ? outcome.VideoPath : null;
            openVideo.Enabled = openFolder.Enabled = videoPath != null && File.Exists(videoPath);
            UpdateButtons();
            if (closeWhenStopped) Close();
        }

        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!runner.Running) { SaveSettings(); return; }
            e.Cancel = true;
            if (closeWhenStopped) return; // already stopping
            if (MessageBox.Show(this, "Stop the conversion?", "fc2mp4", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            closeWhenStopped = true;
            status.Text = "Stopping…";
            cancel.Enabled = false;
            await runner.CancelAsync();
        }
    }
}
```

- [ ] **Step 3: Point `ui/src/Program.cs` at the form**

Replace the body of `Main()` with:

```csharp
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
```

- [ ] **Step 4: Build with a release version and run the tests**

Run: `dotnet build ui/src/Fc2mp4Ui.csproj -c Release -p:Version=0.15.0 && dotnet test ui/tests/Fc2mp4Ui.Tests.csproj`
Expected: build succeeds with 0 errors; tests PASS. (`OnClosing` is `async void` by WinForms' event signature.)

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): the window and the fc2mp4 runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Build it in CI, attach it to releases, document it

**Files:**
- Modify: `.github/workflows/cli.yml` (new `ui` job; `release` needs it and uploads it; notes)
- Modify: `README.md` (Install + Windows usage)

**Interfaces:**
- Consumes: `ui/src/Fc2mp4Ui.csproj`, `ui/tests/Fc2mp4Ui.Tests.csproj`.
- Produces: artifact and release asset `fc2mp4-ui.exe`.

- [ ] **Step 1: Add the `ui` job**

In `.github/workflows/cli.yml`, add after the `build` job (same indentation as `image:`):

```yaml
  ui:
    # The .NET Framework window builds anywhere from reference assemblies; Linux is the cheapest runner.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: dotnet test ui/tests/Fc2mp4Ui.Tests.csproj
      - run: dotnet build ui/src/Fc2mp4Ui.csproj -c Release -p:Version="$(node -p "require('./package.json').version")"
      - run: cp ui/src/bin/Release/net48/fc2mp4-ui.exe fc2mp4-ui.exe
      - uses: actions/upload-artifact@v4
        with:
          name: fc2mp4-ui.exe
          path: fc2mp4-ui.exe
```

In the `release` job: `needs: [build, image, ui]`; in `gh release create`, add `fc2mp4-ui.exe` after `fc2mp4.exe`; replace the notes' first sentence with:

```
Windows: download fc2mp4.exe and fc2mp4-ui.exe into the same folder, then open fc2mp4-ui.exe (or run fc2mp4.exe from PowerShell). macOS: fc2mp4-macos-arm64. Linux: fc2mp4-linux-x64.
```

(keep the Docker and SmartScreen sentences that follow).

- [ ] **Step 2: Check the workflow and the build commands locally**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/cli.yml"); puts "yaml ok"' && dotnet test ui/tests/Fc2mp4Ui.Tests.csproj && dotnet build ui/src/Fc2mp4Ui.csproj -c Release -p:Version="$(node -p "require('./package.json').version")" && ls -la ui/src/bin/Release/net48/fc2mp4-ui.exe`
Expected: `yaml ok`; tests PASS; the exe exists.

- [ ] **Step 3: Update the README**

- Install, Windows bullet: after "download `fc2mp4.exe`…", add: "Also download `fc2mp4-ui.exe` into the same folder for a window instead of PowerShell."
- At the start of `### Windows (PowerShell)`, rename the heading to `### Windows` and insert before the PowerShell text:

```markdown
**The easy way:** put `fc2mp4.exe` and `fc2mp4-ui.exe` in the same folder and open `fc2mp4-ui.exe`.
Paste the replay link and press **Convert**; the console shows the progress, and **Open video**
opens the result. The folders (Fightcade, videos) are under **Settings** and are remembered.
Leave *Fightcade folder* empty unless fc2mp4 does not find Fightcade by itself.

**From PowerShell:**
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/cli.yml README.md
git commit -m "ci: build fc2mp4-ui.exe and attach it to releases; document the window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Windows checks and release v0.15.0

This task needs the user (Windows) and outward-facing pushes: ask before each push.

- [ ] **Step 1: Push the branch (ask first)** and wait for the `cli` workflow run on it. Its artifacts `fc2mp4.exe` and `fc2mp4-ui.exe` are the build to test (`gh run download <run-id> -n fc2mp4.exe -n fc2mp4-ui.exe`, or from the run page).

- [ ] **Step 2: The user runs the manual checks on Windows**, with both exes in one folder:
  1. Open `fc2mp4-ui.exe`: the exe path is pre-filled, status "Ready" (a branch build reports version 0.14.0 from package.json until the bump in Step 3, which is fine since both match).
  2. Paste `https://replay.fightcade.com/fbneo/sfa3/1792152118748-6544`, press Enter: the console fills, the progress line updates in place, "Done: …mp4", Open video plays it, Open folder selects it. Task Manager no longer shows `fc2mp4.exe` once "Done" appears (it must exit although the window holds its stdin). The window's controls fill its width (link field and console not narrow).
  3. Convert it again and press Cancel during "Capturing…": "Cancelled" within a few seconds; Task Manager shows no `fcadefbneo-fc2mp4.exe`, `ffmpeg.exe` or `fc2mp4.exe`.
  4. Convert again and close the window during capture: "Stop the conversion?" → Yes; the window closes; Task Manager shows none of the three.
  5. Set a Fightcade folder with a space in its path (or `C:\Fightcade\` with a trailing `\`) and convert: it works.
  6. Reopen the window: the folders are remembered, the link field is empty.

- [ ] **Step 3: When the checks pass, merge and release (ask first):** fast-forward `main`, `npm version 0.15.0 --no-git-tag-version`, commit `chore: v0.15.0`, annotated tag `v0.15.0`, push `main` and the tag, then confirm the release lists `fc2mp4.exe`, `fc2mp4-ui.exe`, `fc2mp4-macos-arm64`, `fc2mp4-linux-x64`.
