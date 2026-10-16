using System;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class UpdateCheckTests
    {
        static readonly Version V150 = new Version(0, 15, 0);
        static readonly Version V160 = new Version(0, 16, 0);

        [Fact]
        public void ReadsTheLatestTagFromGitHubsAnswer()
        {
            string json = "{\"url\":\"https://api.github.com/x\",\"tag_name\":\"v0.16.0\",\"name\":\"fc2mp4 v0.16.0\",\"draft\":false}";
            Assert.Equal(V160, UpdateCheck.ParseLatestTag(json));
            Assert.Equal(V160, UpdateCheck.ParseLatestTag("{ \"tag_name\" : \"v0.16.0\" }"));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("{\"message\":\"API rate limit exceeded\"}")]
        [InlineData("{\"tag_name\":\"emulator-abc\"}")]
        [InlineData("<html>")]
        public void IgnoresAnythingElse(string json)
        {
            Assert.Null(UpdateCheck.ParseLatestTag(json));
        }

        [Fact]
        public void LabelsTheExeVersion()
        {
            Assert.Equal("Version: v0.15.0", UpdateCheck.VersionLabel(V150, null));
            Assert.Equal("Version: v0.15.0", UpdateCheck.VersionLabel(V150, V150));
            Assert.Equal("Version: v0.15.0 — v0.16.0 is available", UpdateCheck.VersionLabel(V150, V160));
            Assert.Equal("Version: unknown", UpdateCheck.VersionLabel(null, V160));
        }

        [Fact]
        public void NoNoticeWhenUpToDateOrUnknown()
        {
            Assert.Null(UpdateCheck.Notice(V150, V150, V150));
            Assert.Null(UpdateCheck.Notice(null, V150, V150)); // GitHub not reachable
            Assert.Null(UpdateCheck.Notice(V150, V160, V150)); // a newer exe than the release: fine
        }

        [Fact]
        public void TellsWhichFilesToDownloadAgain()
        {
            Assert.Equal("A newer fc2mp4 (v0.16.0) is available: download fc2mp4.exe with the link in Settings",
                UpdateCheck.Notice(V160, V150, V160));
            Assert.Equal("A newer fc2mp4 (v0.16.0) is available: download fc2mp4.exe and fc2mp4-ui.exe again with the link in Settings",
                UpdateCheck.Notice(V160, V150, V150));
            Assert.Equal("A newer fc2mp4 (v0.16.0) is available: download fc2mp4.exe and fc2mp4-ui.exe again with the link in Settings",
                UpdateCheck.Notice(V160, V160, V150)); // only the window is old
        }

        [Fact]
        public void ALocalWindowBuildOnlyComparesTheExe()
        {
            Assert.Null(UpdateCheck.Notice(V160, V160, new Version(0, 0, 0)));
            Assert.Equal("A newer fc2mp4 (v0.16.0) is available: download fc2mp4.exe with the link in Settings",
                UpdateCheck.Notice(V160, V150, new Version(0, 0, 0)));
        }

        [Fact]
        public void ParsesVersionsLikeFc2mp4PrintsThem()
        {
            Assert.Equal(V150, VersionCheck.Parse("0.15.0\r\n"));
            Assert.Equal(V150, VersionCheck.Parse("v0.15.0-rc1"));
            Assert.Null(VersionCheck.Parse("dev"));
            Assert.Null(VersionCheck.Parse(null));
        }
    }
}
