using System;
using System.Text.RegularExpressions;

namespace Fc2mp4Ui
{
    // The latest fc2mp4 release on GitHub, compared with the chosen fc2mp4.exe and with this window.
    public static class UpdateCheck
    {
        public const string ReleasesUrl = "https://github.com/Coccis77/fightcade-replay-converter/releases/latest";
        public const string ApiUrl = "https://api.github.com/repos/Coccis77/fightcade-replay-converter/releases/latest";

        static readonly Regex TagName = new Regex("\"tag_name\"\\s*:\\s*\"([^\"]*)\"");

        // The "tag_name" of GitHub's answer for the latest release, or null for anything else
        // (an error message, a rate limit, a tag that is not a version).
        public static Version ParseLatestTag(string json)
        {
            Match m = TagName.Match(json ?? "");
            return m.Success ? VersionCheck.Parse(m.Groups[1].Value) : null;
        }

        public static string VersionLabel(Version exe, Version latest)
        {
            if (exe == null) return "Version: unknown";
            string label = "Version: v" + exe;
            if (latest != null && latest > exe) label += " — v" + latest + " is available";
            return label;
        }

        // Null when there is nothing newer (or GitHub could not be reached).
        public static string Notice(Version latest, Version exe, Version window)
        {
            if (latest == null) return null;
            bool localWindow = window == null || new Version(window.Major, window.Minor, Math.Max(window.Build, 0)) == new Version(0, 0, 0);
            bool windowOld = !localWindow && latest > new Version(window.Major, window.Minor, Math.Max(window.Build, 0));
            bool exeOld = exe != null && latest > exe;
            if (windowOld) return "A newer fc2mp4 (v" + latest + ") is available: download fc2mp4.exe and fc2mp4-ui.exe again with the link in Settings";
            if (exeOld) return "A newer fc2mp4 (v" + latest + ") is available: download fc2mp4.exe with the link in Settings";
            return null;
        }
    }
}
