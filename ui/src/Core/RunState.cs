namespace Fc2mp4Ui
{
    public enum CloseAction { CloseNow, Ask, Wait }

    // What the window may do while fc2mp4 runs. "Running" lasts until the window has handled fc2mp4's
    // exit (not just until the process ended), so nothing reaches a window that already closed.
    public sealed class RunState
    {
        bool closeWhenStopped;

        public bool Running { get; private set; }
        public bool Stopping { get; private set; }
        public bool ShowsProgress => Running && !Stopping;

        public void Started()
        {
            Running = true;
            Stopping = false;
            closeWhenStopped = false;
        }

        // True when fc2mp4 should be asked to stop now.
        public bool CancelRequested()
        {
            if (!Running || Stopping) return false;
            Stopping = true;
            return true;
        }

        public CloseAction CloseRequested()
        {
            if (!Running) return CloseAction.CloseNow;
            return closeWhenStopped ? CloseAction.Wait : CloseAction.Ask;
        }

        // The user said "Yes, stop it". True: stop fc2mp4, the window closes when it has exited.
        // False: fc2mp4 already finished while the question was open, so close now.
        public bool CloseConfirmed()
        {
            if (!Running) return false;
            closeWhenStopped = true;
            Stopping = true;
            return true;
        }

        // fc2mp4 exited and the window showed the outcome. True: close the window now.
        public bool Finished()
        {
            bool close = closeWhenStopped;
            Running = false;
            Stopping = false;
            closeWhenStopped = false;
            return close;
        }
    }
}
