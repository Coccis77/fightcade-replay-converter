using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class Fc2mp4CommandTests
    {
        [Fact]
        public void PassesTheLinkTheOutputFolderX264AndTheStopOption()
        {
            Assert.Equal(
                new[] { "https://replay.fightcade.com/fbneo/sfa3/1-2", "-o", @"C:\Videos", "--encoder", "x264", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("https://replay.fightcade.com/fbneo/sfa3/1-2", @"C:\Videos", ""));
        }

        [Fact]
        public void AddsTheFightcadeFolderOnlyWhenSet()
        {
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--fightcade-dir", @"D:\Fightcade", "--encoder", "x264", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", @"D:\Fightcade"));
            Assert.DoesNotContain("--fightcade-dir", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "   "));
        }

        [Fact]
        public void AlwaysPassesTheEncoder_X264ForAnUnknownOrRemovedOne()
        {
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--encoder", "nvenc", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", "nvenc"));
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--encoder", "x264", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", "auto"));
            Assert.Contains("x264", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", ""));
        }

        [Fact]
        public void TrimsWhatWasPasted()
        {
            Assert.Equal("https://replay.fightcade.com/fbneo/garou/1-2",
                Fc2mp4Command.Arguments("  https://replay.fightcade.com/fbneo/garou/1-2\r\n", @"C:\V", "")[0]);
            Assert.Equal(@"D:\Fightcade", Fc2mp4Command.Arguments("1-2", @"C:\V", @" D:\Fightcade ")[4]);
        }
    }
}
