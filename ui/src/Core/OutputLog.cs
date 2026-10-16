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
