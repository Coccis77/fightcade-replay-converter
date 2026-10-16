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
