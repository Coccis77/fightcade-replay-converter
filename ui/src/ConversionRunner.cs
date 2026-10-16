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
