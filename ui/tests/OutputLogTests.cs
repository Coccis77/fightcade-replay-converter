using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class OutputLogTests
    {
        [Fact]
        public void KeepsLinesAndUpdatesTheProgressLineInPlace()
        {
            var log = new OutputLog();
            log.Add("Preparing ffmpeg and the emulator (the first run downloads them)…");
            log.Add("Connecting to the replay stream…");
            log.Add("Capturing… 1s of replay (60 frames, ×1.0)");
            log.Add("Capturing… 2s of replay (120 frames, ×2.0)");
            Assert.Equal(new[]
            {
                "Preparing ffmpeg and the emulator (the first run downloads them)…",
                "Connecting to the replay stream…",
                "Capturing… 2s of replay (120 frames, ×2.0)",
            }, log.Lines);
            Assert.Equal("Capturing… 2s of replay (120 frames, ×2.0)", log.Progress);
            log.Add("Finalizing the MP4…");
            log.Add("Captured 0:02 of replay.");
            Assert.Equal(5, log.Lines.Count);
        }

        [Fact]
        public void SkipsBlankLinesAndNulls()
        {
            var log = new OutputLog();
            log.Add("");
            log.Add(null);
            log.Add("   ");
            log.Add("Stopping…");
            Assert.Equal(new[] { "Stopping…" }, log.Lines);
            Assert.Null(log.Progress);
        }

        [Fact]
        public void JoinsLinesForTheConsole()
        {
            var log = new OutputLog();
            log.Add("a");
            log.Add("b");
            Assert.Equal("a" + System.Environment.NewLine + "b", log.Text);
        }

        [Fact]
        public void SaysWhetherALineWasAddedReplacedOrIgnored()
        {
            var log = new OutputLog();
            Assert.Equal(LogChange.Added, log.Add("Connecting to the replay stream…"));
            Assert.Equal(LogChange.Added, log.Add("Capturing… 1s of replay"));
            Assert.Equal(LogChange.Replaced, log.Add("Capturing… 2s of replay"));
            Assert.Equal(LogChange.Ignored, log.Add("  "));
            Assert.Equal(LogChange.Added, log.Add("Finalizing the MP4…"));
        }
    }
}
