using System;
using System.Text.RegularExpressions;

namespace Fc2mp4Ui
{
    // The latest fc2mp4 release on GitHub.
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
    }
}
