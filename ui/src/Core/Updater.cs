using System;

namespace Fc2mp4Ui
{
    // Updating = running the release's installer silently over this install (Inno Setup replaces both exes
    // and reopens the window). A local build (version 0.0.0) never updates.
    public static class Updater
    {
        // /SILENT: no wizard pages, but a progress window and the installer's own error messages, so the
        // seconds between the window closing and reopening are not blank.
        public const string SilentArgs = "/SILENT /SUPPRESSMSGBOXES /NORESTART";

        static Version Short(Version v) => new Version(v.Major, v.Minor, Math.Max(v.Build, 0));

        public static bool IsLocalBuild(Version v) => v == null || Short(v) == new Version(0, 0, 0);

        public static bool Offer(Version latest, Version running) => latest != null && !IsLocalBuild(running) && Short(latest) > Short(running);

        // The exact version offered, not "latest": it cannot change between the offer and the download.
        public static string SetupUrl(Version v) => "https://github.com/Coccis77/fightcade-replay-converter/releases/download/v" + Short(v) + "/fc2mp4-setup.exe";

        // Null when the file can be run: complete (when the server announced a length) and a Windows program.
        public static string CheckDownload(byte[] head, long length, long expected)
        {
            if (head == null || head.Length < 2 || length < 2 || head[0] != (byte)'M' || head[1] != (byte)'Z') return "The update download isn't a Windows program";
            // The size must be known: without it a cut download could not be told from a whole one.
            if (expected <= 0 || length != expected) return "The update couldn't be downloaded completely";
            return null;
        }

        // Downloaded installers, deleted at the next start (the one that just ran was still in use).
        public static bool IsDownloadedSetup(string fileName) =>
            System.Text.RegularExpressions.Regex.IsMatch(fileName ?? "", @"^fc2mp4-setup-v\d+\.\d+\.\d+\.exe$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        // Pre-releases (1.0.0-rc1) are compared as their release: a Windows program version cannot carry the
        // suffix. fc2mp4 does not publish pre-releases.
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
