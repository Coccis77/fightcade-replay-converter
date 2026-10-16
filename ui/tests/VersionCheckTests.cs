using System;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class VersionCheckTests
    {
        static readonly Version Window = new Version(0, 15, 0, 0);

        [Theory]
        [InlineData("0.15.0\n")]
        [InlineData("0.16.2")]
        [InlineData("v1.0.0")]
        public void AcceptsTheSameOrNewer(string output)
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(Window, output).Status);
        }

        [Fact]
        public void RefusesAnOlderExeWithTheMessage()
        {
            var v = VersionCheck.Evaluate(Window, "0.14.0\r\n");
            Assert.Equal(VersionStatus.TooOld, v.Status);
            Assert.Equal("This fc2mp4.exe is too old for this window (v0.14.0): download the latest one", v.Message);
        }

        [Theory]
        [InlineData("dev")]
        [InlineData("")]
        [InlineData(null)]
        [InlineData("Usage: fc2mp4 …")]
        public void WarnsWhenTheVersionCannotBeRead(string output)
        {
            var v = VersionCheck.Evaluate(Window, output);
            Assert.Equal(VersionStatus.Unknown, v.Status);
            Assert.Equal("Could not read this fc2mp4.exe's version; it may not work with this window", v.Message);
        }

        [Fact]
        public void ALocalWindowBuildChecksNothing()
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(new Version(0, 0, 0, 0), "0.1.0").Status);
        }

        [Fact]
        public void APrereleaseCountsAsItsVersion()
        {
            Assert.Equal(VersionStatus.Ok, VersionCheck.Evaluate(Window, "0.15.0-rc1").Status);
        }
    }
}
