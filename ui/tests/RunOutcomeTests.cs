using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class RunOutcomeTests
    {
        [Fact]
        public void DoneWithTheVideoPathFromTheLastStdoutLine()
        {
            var o = RunOutcome.From(0, false, new[] { "", @"C:\Videos\1-2.mp4", "" }, new string[0]);
            Assert.Equal(OutcomeKind.Done, o.Kind);
            Assert.Equal(@"C:\Videos\1-2.mp4", o.VideoPath);
            Assert.Equal(@"Done: C:\Videos\1-2.mp4", o.Message);
        }

        [Fact]
        public void CancelledOnExit130_AndForcedWhateverTheCode()
        {
            Assert.Equal("Cancelled", RunOutcome.From(130, false, new string[0], new string[0]).Message);
            var forced = RunOutcome.From(1, true, new string[0], new[] { "Error: whatever" });
            Assert.Equal(OutcomeKind.Cancelled, forced.Kind);
            Assert.Equal("Cancelled (forced)", forced.Message);
        }

        [Fact]
        public void FailedShowsTheLastHint_ElseTheLastError_ElseTheExitCode()
        {
            var stderr = new[]
            {
                "Hint: an earlier hint from a warning",
                "Error: Garou: Mark of the Wolves ROM not found: C:\\F\\ROMs\\neogeo.zip",
                "Hint: Open Garou once in Fightcade so it downloads the ROM",
            };
            var o = RunOutcome.From(3, false, new string[0], stderr);
            Assert.Equal(OutcomeKind.Failed, o.Kind);
            Assert.Equal("Failed: Open Garou once in Fightcade so it downloads the ROM", o.Message);
            Assert.Null(o.VideoPath);

            Assert.Equal("Failed: Fightcade install not found",
                RunOutcome.From(3, false, new string[0], new[] { "Error: Fightcade install not found" }).Message);
            Assert.Equal("Failed: fc2mp4 stopped (exit 7)", RunOutcome.From(7, false, new string[0], new string[0]).Message);
        }

        [Fact]
        public void TheFinalErrorsHintWinsOverAnEarlierOne()
        {
            var stderr = new[] { "Hint: early", "Error: late failure" };
            Assert.Equal("Failed: late failure", RunOutcome.From(6, false, new string[0], stderr).Message);
        }
    }
}
