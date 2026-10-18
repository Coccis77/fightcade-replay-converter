using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class Fc2mp4CommandTests
    {
        [Fact]
        public void PassesTheLinkTheOutputFolderAndTheStopOption()
        {
            Assert.Equal(
                new[] { "https://replay.fightcade.com/fbneo/sfa3/1-2", "-o", @"C:\Videos", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("https://replay.fightcade.com/fbneo/sfa3/1-2", @"C:\Videos", ""));
        }

        [Fact]
        public void AddsTheFightcadeFolderOnlyWhenSet()
        {
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--fightcade-dir", @"D:\Fightcade", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", @"D:\Fightcade"));
            Assert.DoesNotContain("--fightcade-dir", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "   "));
        }

        [Fact]
        public void PassesTheEncoderUnlessAutomatic()
        {
            Assert.Equal(
                new[] { "1-2", "-o", @"C:\Videos", "--encoder", "nvenc", "--stop-on-stdin-close" },
                Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", "nvenc"));
            Assert.Contains("x264", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", "x264"));
            Assert.DoesNotContain("--encoder", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", "auto"));
            Assert.DoesNotContain("--encoder", Fc2mp4Command.Arguments("1-2", @"C:\Videos", "", ""));
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
