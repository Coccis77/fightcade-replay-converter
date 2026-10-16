using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class RunStateTests
    {
        [Fact]
        public void IdleClosesAtOnce()
        {
            Assert.Equal(CloseAction.CloseNow, new RunState().CloseRequested());
        }

        [Fact]
        public void RunningAsksBeforeClosing_ThenStopsAndClosesWhenFinished()
        {
            var s = new RunState();
            s.Started();
            Assert.Equal(CloseAction.Ask, s.CloseRequested());
            Assert.True(s.CloseConfirmed()); // must stop fc2mp4 first
            Assert.True(s.Stopping);
            Assert.Equal(CloseAction.Wait, s.CloseRequested()); // a second close while stopping
            Assert.True(s.Finished()); // close now
            Assert.False(s.Running);
        }

        // fc2mp4 finished while "Stop the conversion?" was open: Yes must close at once, not show "Stopping…".
        [Fact]
        public void ConfirmingAfterFc2mp4AlreadyFinishedClosesAtOnce()
        {
            var s = new RunState();
            s.Started();
            Assert.Equal(CloseAction.Ask, s.CloseRequested());
            Assert.False(s.Finished()); // finished while the question was open: do not close by itself
            Assert.False(s.CloseConfirmed()); // nothing to stop: close now
            Assert.False(s.Stopping);
        }

        [Fact]
        public void ANewConversionForgetsAnEarlierCloseRequest()
        {
            var s = new RunState();
            s.Started();
            s.CloseConfirmed();
            s.Finished();
            s.Started();
            Assert.False(s.Finished()); // this run's end must not close the window
        }

        [Fact]
        public void CancelOnlyOnce_AndProgressNoLongerShownWhileStopping()
        {
            var s = new RunState();
            Assert.False(s.CancelRequested()); // idle: nothing to cancel
            s.Started();
            Assert.True(s.ShowsProgress);
            Assert.True(s.CancelRequested());
            Assert.False(s.CancelRequested());
            Assert.False(s.ShowsProgress);
            Assert.True(s.Running); // still running until fc2mp4 exits
        }
    }
}
