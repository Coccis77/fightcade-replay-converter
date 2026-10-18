using System.Collections.Generic;
using System.Linq;

namespace Fc2mp4Ui
{
    // The links of one Convert, converted one after the other. A failed link does not stop the others;
    // Cancel stops the run. One link keeps the single-conversion messages.
    public sealed class Batch
    {
        readonly List<string> links;
        readonly List<RunOutcome> results = new List<RunOutcome>();
        bool cancelled;

        public Batch(IReadOnlyList<string> links) { this.links = new List<string>(links); }

        public int Count => links.Count;
        public int Number => results.Count + 1;
        public bool IsFinished => cancelled || results.Count >= links.Count;
        public string CurrentLink => links[results.Count];
        public string Header() => "── " + Number + "/" + Count + "  " + CurrentLink;
        public string Progress(string detail) => Count == 1 ? detail : "Converting " + Number + " of " + Count + ": " + detail;

        public void Record(RunOutcome outcome) => results.Add(outcome);
        public void Cancel() => cancelled = true;

        public string LastVideo => results.LastOrDefault(r => r.Kind == OutcomeKind.Done)?.VideoPath;

        bool WasCancelled => cancelled || results.Any(r => r.Kind == OutcomeKind.Cancelled);
        int DoneCount => results.Count(r => r.Kind == OutcomeKind.Done);
        int FailedCount => results.Count(r => r.Kind == OutcomeKind.Failed);

        public string Summary()
        {
            if (Count == 1 && results.Count == 1) return results[0].Message;
            if (WasCancelled) return "Cancelled after " + (DoneCount + FailedCount) + " of " + Count;
            return FailedCount == 0 ? "Done: " + DoneCount + " videos" : DoneCount + " done, " + FailedCount + " failed (see the console)";
        }

        // What stays in the links box: the links that failed or were not converted.
        public List<string> Remaining()
        {
            var left = new List<string>();
            for (int i = 0; i < links.Count; i++)
                if (i >= results.Count || results[i].Kind != OutcomeKind.Done) left.Add(links[i]);
            return left;
        }

        // Null after Cancel: the user is there.
        public string NotificationText()
        {
            if (WasCancelled) return null;
            if (Count == 1) return DoneCount == 1 ? "fc2mp4: video ready" : "fc2mp4: conversion failed";
            return FailedCount == 0 ? "fc2mp4: " + DoneCount + " videos ready" : "fc2mp4: " + DoneCount + " done, " + FailedCount + " failed";
        }
    }
}
