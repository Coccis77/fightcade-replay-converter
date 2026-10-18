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

        // fc2mp4-cli.exe could not even be started for this link.
        public static RunOutcome Failure(string message) => new RunOutcome { Kind = OutcomeKind.Failed, Message = "Failed: " + message };

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
