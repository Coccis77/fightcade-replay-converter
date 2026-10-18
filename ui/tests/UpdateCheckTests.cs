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
        public void ParsesVersionsLikeFc2mp4PrintsThem()
        {
            Assert.Equal(V150, VersionCheck.Parse("0.15.0\r\n"));
            Assert.Equal(V150, VersionCheck.Parse("v0.15.0-rc1"));
            Assert.Null(VersionCheck.Parse("dev"));
            Assert.Null(VersionCheck.Parse(null));
        }
    }
}
