using System;
using System.Text.RegularExpressions;

namespace Fc2mp4Ui
{
    // Versions as fc2mp4 prints them and as release tags name them.
    public static class VersionCheck
    {
        static readonly Regex Semver = new Regex(@"^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$");

        // "0.15.0", "v0.15.0" or "0.15.0-rc1" (what fc2mp4 --version and release tags look like); null otherwise.
        public static Version Parse(string text)
        {
            Match m = Semver.Match((text ?? "").Trim());
            if (!m.Success) return null;
            return new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value));
        }
    }
}
