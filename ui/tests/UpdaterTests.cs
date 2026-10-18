using System;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class UpdaterTests
    {
        static readonly Version Running = new Version(0, 18, 0, 0);
        static readonly Version Local = new Version(0, 0, 0, 0);

        [Fact]
        public void OffersOnlyANewerRelease()
        {
            Assert.True(Updater.Offer(new Version(0, 19, 0), Running));
            Assert.False(Updater.Offer(new Version(0, 18, 0), Running));
            Assert.False(Updater.Offer(new Version(0, 17, 0), Running));
            Assert.False(Updater.Offer(null, Running)); // GitHub not reachable
        }

        [Fact]
        public void ALocalBuildNeverUpdates()
        {
            Assert.True(Updater.IsLocalBuild(Local));
            Assert.False(Updater.Offer(new Version(9, 0, 0), Local));
            Assert.Null(Updater.UpdatedNotice("0.17.0", Local));
            Assert.Equal("Version: development build", Updater.VersionLabel(Local));
            Assert.Equal("", Updater.VersionText(Local));
        }

        [Fact]
        public void DownloadsTheExactVersionsInstaller()
        {
            Assert.Equal("https://github.com/Coccis77/fightcade-replay-converter/releases/download/v0.19.0/fc2mp4-setup.exe", Updater.SetupUrl(new Version(0, 19, 0)));
            Assert.Equal("/SILENT /SUPPRESSMSGBOXES /NORESTART", Updater.SilentArgs); // a progress window, and the installer's own errors
        }

        [Fact]
        public void RunsOnlyAWholeWindowsProgram()
        {
            byte[] mz = { (byte)'M', (byte)'Z' };
            Assert.Null(Updater.CheckDownload(mz, 1000, 1000));
            Assert.Null(Updater.CheckDownload(mz, 1000, -1)); // length not announced
            Assert.Equal("The update couldn't be downloaded completely", Updater.CheckDownload(mz, 999, 1000));
            Assert.Equal("The update download isn't a Windows program", Updater.CheckDownload(new[] { (byte)'<', (byte)'!' }, 1000, 1000));
            Assert.Equal("The update download isn't a Windows program", Updater.CheckDownload(new byte[0], 0, -1));
        }

        [Fact]
        public void SaysUpdatedOnceAfterAnUpdate()
        {
            Assert.Equal("Updated to v0.18.0", Updater.UpdatedNotice("0.17.0", Running));
            Assert.Null(Updater.UpdatedNotice("0.18.0", Running));
            Assert.Null(Updater.UpdatedNotice("", Running)); // first run ever
            Assert.Null(Updater.UpdatedNotice("garbage", Running));
            Assert.Equal("0.18.0", Updater.VersionText(Running));
            Assert.Equal("Version: v0.18.0", Updater.VersionLabel(Running));
        }
    }
}
