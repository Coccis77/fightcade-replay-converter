using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class BatchTests
    {
        static RunOutcome Done(string path) => RunOutcome.From(0, false, new[] { path }, new string[0]);
        static RunOutcome Failed(string hint) => RunOutcome.From(3, false, new string[0], new[] { "Error: x", "Hint: " + hint });
        static RunOutcome Cancelled() => RunOutcome.From(130, false, new string[0], new string[0]);

        [Fact]
        public void OneLinkKeepsTodaysMessages()
        {
            var b = new Batch(new[] { "a" });
            Assert.Equal("Starting…", b.Progress("Starting…"));
            b.Record(Done(@"C:\V\a.mp4"));
            Assert.True(b.IsFinished);
            Assert.Equal(@"Done: C:\V\a.mp4", b.Summary());
            Assert.Equal("fc2mp4: video ready", b.NotificationText());
            Assert.Empty(b.Remaining());

            var f = new Batch(new[] { "a" });
            f.Record(Failed("Open Garou"));
            Assert.Equal("Failed: Open Garou", f.Summary());
            Assert.Equal("fc2mp4: conversion failed", f.NotificationText());
            Assert.Equal(new[] { "a" }, f.Remaining());
        }

        [Fact]
        public void SeveralLinksRunInOrderAndAFailureDoesNotStopTheRest()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            Assert.Equal("── 1/3  a", b.Header());
            Assert.Equal("Converting 1 of 3: Capturing… 5s", b.Progress("Capturing… 5s"));
            b.Record(Done(@"C:\V\a.mp4"));
            Assert.Equal(2, b.Number);
            Assert.Equal("b", b.CurrentLink);
            b.Record(Failed("ROM missing"));
            Assert.False(b.IsFinished);
            b.Record(Done(@"C:\V\c.mp4"));
            Assert.True(b.IsFinished);
            Assert.Equal("2 done, 1 failed (see the console)", b.Summary());
            Assert.Equal("fc2mp4: 2 done, 1 failed", b.NotificationText());
            Assert.Equal(new[] { "b" }, b.Remaining());
            Assert.Equal(@"C:\V\c.mp4", b.LastVideo);
        }

        [Fact]
        public void AllDone()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            b.Record(Done("1"));
            b.Record(Done("2"));
            b.Record(Done("3"));
            Assert.Equal("Done: 3 videos", b.Summary());
            Assert.Equal("fc2mp4: 3 videos ready", b.NotificationText());
        }

        [Fact]
        public void CancelStopsTheRunKeepsTheRestAndDoesNotNotify()
        {
            var b = new Batch(new[] { "a", "b", "c" });
            b.Record(Done(@"C:\V\a.mp4"));
            b.Record(Cancelled());
            b.Cancel();
            Assert.True(b.IsFinished);
            Assert.Equal("Cancelled after 1 of 3", b.Summary());
            Assert.Null(b.NotificationText());
            Assert.Equal(new[] { "b", "c" }, b.Remaining());

            var one = new Batch(new[] { "a" });
            one.Record(Cancelled());
            one.Cancel();
            Assert.Equal("Cancelled", one.Summary());
            Assert.Null(one.NotificationText());
        }

        [Fact]
        public void AFailureToStartIsAFailedLink()
        {
            Assert.Equal("Failed: could not start fc2mp4-cli.exe: boom", RunOutcome.Failure("could not start fc2mp4-cli.exe: boom").Message);
            Assert.Equal(OutcomeKind.Failed, RunOutcome.Failure("x").Kind);
        }
    }
}
