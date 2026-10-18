using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    public sealed class MainForm : Form
    {
        const string HelpText = "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).";

        readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fc2mp4-ui", "settings.txt");
        readonly string cliPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fc2mp4-cli.exe");
        readonly Version windowVersion = typeof(MainForm).Assembly.GetName().Version;
        readonly ConversionRunner runner = new ConversionRunner();
        readonly RunState state = new RunState();
        readonly List<Button> browseButtons = new List<Button>();
        readonly NotifyIcon notifier = new NotifyIcon { Icon = SystemIcons.Application, Text = "fc2mp4" };

        // Wraps, and the text is capped, so the buttons ("Download from GitHub" after a failure) stay visible.
        readonly FlowLayoutPanel updateBar = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Visible = false, BackColor = SystemColors.Info, Padding = new Padding(4), WrapContents = true };
        readonly Label updateText = new Label { AutoSize = true, MaximumSize = new Size(560, 0), Padding = new Padding(0, 6, 8, 0) };
        readonly Button updateNow = new Button { Text = "Update now", AutoSize = true };
        readonly Button updateLater = new Button { Text = "Later", AutoSize = true };
        readonly Button updateGitHub = new Button { Text = "Download from GitHub", AutoSize = true, Visible = false };

        // MinimumSize, not Height: an auto-sized layout row sizes a TextBox to one line otherwise.
        readonly TextBox links = new TextBox { Dock = DockStyle.Fill, Multiline = true, AcceptsReturn = true, ScrollBars = ScrollBars.Vertical, MinimumSize = new Size(0, 64) };
        readonly Button convert = new Button { Text = "Convert", AutoSize = true };
        readonly Button cancel = new Button { Text = "Cancel", AutoSize = true, Enabled = false };
        readonly Label status = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
        readonly TextBox console = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font(FontFamily.GenericMonospace, 9f), BackColor = SystemColors.Window };
        readonly Button openVideo = new Button { Text = "Open video", AutoSize = true, Enabled = false };
        readonly Button openFolder = new Button { Text = "Open folder", AutoSize = true, Enabled = false };
        readonly TextBox fightcade = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox output = new TextBox { Dock = DockStyle.Fill };
        readonly ComboBox encoder = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
        readonly Label encoderHelp = new Label { AutoSize = true, MaximumSize = new Size(560, 0), ForeColor = SystemColors.GrayText };
        readonly Label versionLabel = new Label { AutoSize = true, Anchor = AnchorStyles.Left };

        Settings settings;
        string startNotice;
        bool cliPresent;
        Batch batch;
        string consoleBefore = "";
        OutputLog log = new OutputLog();
        List<string> stdout = new List<string>();
        List<string> stderr = new List<string>();
        string videoPath;
        Version latestVersion;
        bool updateDismissed;
        bool updating;
        string updateError;

        public MainForm()
        {
            Text = "fc2mp4";
            MinimumSize = new Size(640, 520);
            Size = new Size(760, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BuildLayout();

            string defaultOutput = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Videos", "Fightcade");
            settings = Settings.Load(settingsPath, defaultOutput);
            fightcade.Text = settings.FightcadeFolder;
            output.Text = settings.OutputFolder;
            encoder.Items.AddRange(Encoders.Labels);
            encoder.SelectedIndex = Array.IndexOf(Encoders.Names, settings.Encoder);
            encoderHelp.Text = Encoders.Describe(settings.Encoder);
            encoder.SelectedIndexChanged += (s, e) => encoderHelp.Text = Encoders.Describe(SelectedEncoder());
            versionLabel.Text = Updater.VersionLabel(windowVersion);
            startNotice = Updater.UpdatedNotice(settings.LastVersion, windowVersion);
            settings.LastVersion = Updater.VersionText(windowVersion);
            SaveSettings();

            links.TextChanged += (s, e) => UpdateButtons();
            links.KeyDown += (s, e) => { if (e.Control && e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; StartRun(); } };
            convert.Click += (s, e) => StartRun();
            cancel.Click += async (s, e) => await StopAsync();
            openVideo.Click += (s, e) => { if (videoPath != null) Run(new ProcessStartInfo(videoPath) { UseShellExecute = true }); };
            openFolder.Click += (s, e) => { if (videoPath != null) Run(new ProcessStartInfo("explorer.exe", "/select," + WindowsArgs.Quote(videoPath))); };
            updateNow.Click += (s, e) => UpdateNow();
            updateLater.Click += (s, e) => { updateDismissed = true; ShowUpdateBar(); };
            updateGitHub.Click += (s, e) => Run(new ProcessStartInfo(UpdateCheck.ReleasesUrl) { UseShellExecute = true });
            notifier.BalloonTipClicked += (s, e) => { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); };
            runner.StderrLine += line => Post(() => OnStderr(line));
            runner.StdoutLine += line => Post(() => stdout.Add(line));
            runner.Exited += (code, forced) => Post(() => OnExited(code, forced));
            Shown += (s, e) => { CheckCli(); links.Focus(); _ = CheckForUpdateAsync(); };
            FormClosing += OnClosing;
            FormClosed += (s, e) => notifier.Dispose();
        }

        void BuildLayout()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10) };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // update bar
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // links
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // buttons
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));   // status
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // console
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // open buttons
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // settings

            updateBar.Controls.Add(updateText);
            updateBar.Controls.Add(updateNow);
            updateBar.Controls.Add(updateLater);
            updateBar.Controls.Add(updateGitHub);
            root.Controls.Add(updateBar);

            var linkRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            linkRow.Controls.Add(new Label { Text = "Replay links\n(one per line)", AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Top }, 0, 0);
            linkRow.Controls.Add(links, 1, 0);
            root.Controls.Add(linkRow);

            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
            actions.Controls.Add(cancel);
            actions.Controls.Add(convert);
            root.Controls.Add(actions);

            root.Controls.Add(status);
            root.Controls.Add(console);

            var opens = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, AutoSize = true };
            opens.Controls.Add(openFolder);
            opens.Controls.Add(openVideo);
            root.Controls.Add(opens);

            var group = new GroupBox { Text = "Settings", Dock = DockStyle.Fill, AutoSize = true, Padding = new Padding(8) };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, AutoSize = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            AddPathRow(grid, 0, "Fightcade folder", fightcade, () => BrowseFolder(fightcade, "Fightcade folder (the one that contains emulator\\fbneo)"));
            AddPathRow(grid, 1, "Output folder", output, () => BrowseFolder(output, "Folder for the videos"));
            grid.Controls.Add(new Label { Text = "Encoder", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 2);
            grid.Controls.Add(encoder, 1, 2);
            grid.SetColumnSpan(encoder, 2);
            grid.Controls.Add(encoderHelp, 1, 3);
            grid.SetColumnSpan(encoderHelp, 2);
            grid.Controls.Add(versionLabel, 1, 4);
            grid.SetColumnSpan(versionLabel, 2);
            var help = new Label { Text = HelpText, AutoSize = true, MaximumSize = new Size(680, 0), ForeColor = SystemColors.GrayText, Padding = new Padding(0, 6, 0, 0) };
            grid.Controls.Add(help, 0, 5);
            grid.SetColumnSpan(help, 3);
            group.Controls.Add(grid);
            root.Controls.Add(group);

            Controls.Add(root);
        }

        void AddPathRow(TableLayoutPanel grid, int row, string label, TextBox box, Action browse)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            grid.Controls.Add(box, 1, row);
            var button = new Button { Text = "Browse…", AutoSize = true };
            button.Click += (s, e) => browse();
            browseButtons.Add(button);
            grid.Controls.Add(button, 2, row);
        }

        void BrowseFolder(TextBox box, string description)
        {
            using (var dialog = new FolderBrowserDialog { Description = description, SelectedPath = box.Text })
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
        }

        void CheckCli()
        {
            cliPresent = File.Exists(cliPath);
            status.Text = !cliPresent ? "fc2mp4-cli.exe is missing: reinstall fc2mp4" : startNotice ?? "Ready";
            startNotice = null;
            UpdateButtons();
        }

        void Run(ProcessStartInfo start)
        {
            try { Process.Start(start); }
            catch (Exception e) { status.Text = "Could not open it: " + e.Message; }
        }

        // Events from fc2mp4-cli arrive on other threads; once the window is gone they are dropped.
        void Post(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { } // includes ObjectDisposedException
        }

        void UpdateButtons()
        {
            bool running = state.Running;
            convert.Enabled = cliPresent && !running && !updating && LinkList.Parse(links.Text).Count > 0;
            cancel.Enabled = running && !state.Stopping;
            foreach (var box in new[] { links, fightcade, output }) box.ReadOnly = running;
            foreach (var button in browseButtons) button.Enabled = !running;
            encoder.Enabled = !running;
            ShowUpdateBar();
        }

        string SelectedEncoder() => encoder.SelectedIndex >= 0 ? Encoders.Names[encoder.SelectedIndex] : "auto";

        void SaveSettings()
        {
            settings.FightcadeFolder = fightcade.Text.Trim();
            settings.OutputFolder = output.Text.Trim();
            settings.Encoder = SelectedEncoder();
            try { settings.Save(settingsPath); } catch (Exception) { }
        }

        // ---- Conversions: the links one after the other ----

        void StartRun()
        {
            if (!convert.Enabled) return;
            string folderError = OutputFolder.Ensure(output.Text);
            if (folderError != null) { status.Text = "Failed: " + folderError; return; }
            SaveSettings();
            batch = new Batch(LinkList.Parse(links.Text));
            consoleBefore = "";
            console.Text = "";
            videoPath = null;
            openVideo.Enabled = openFolder.Enabled = false;
            state.Started();
            UpdateButtons();
            RunNext();
        }

        void RunNext()
        {
            if (state.Stopping) batch.Cancel();
            if (batch.IsFinished) { FinishRun(); return; }
            log = new OutputLog();
            stdout = new List<string>();
            stderr = new List<string>();
            if (batch.Count > 1) consoleBefore += (consoleBefore.Length > 0 ? Environment.NewLine + Environment.NewLine : "") + batch.Header() + Environment.NewLine;
            console.Text = consoleBefore;
            status.Text = batch.Progress("Starting…");
            try
            {
                runner.Start(cliPath, Fc2mp4Command.Arguments(batch.CurrentLink, output.Text, fightcade.Text, SelectedEncoder()));
            }
            catch (Exception e)
            {
                var failed = RunOutcome.Failure("could not start fc2mp4-cli.exe: " + e.Message);
                consoleBefore += failed.Message;
                batch.Record(failed);
                Post(RunNext);
            }
        }

        void OnStderr(string line)
        {
            stderr.Add(line);
            log.Add(line);
            console.Text = consoleBefore + log.Text;
            console.SelectionStart = console.TextLength;
            console.ScrollToCaret();
            if (state.ShowsProgress && log.Progress != null && line == log.Progress) status.Text = batch.Progress(line);
        }

        void OnExited(int code, bool forced)
        {
            var outcome = RunOutcome.From(code, forced, stdout, stderr);
            consoleBefore = console.Text;
            if (batch.Count > 1) consoleBefore += Environment.NewLine + outcome.Message;
            batch.Record(outcome);
            if (outcome.Kind == OutcomeKind.Done) videoPath = outcome.VideoPath;
            RunNext();
        }

        void FinishRun()
        {
            bool close = state.Finished();
            console.Text = consoleBefore;
            status.Text = batch.Summary();
            links.Text = string.Join(Environment.NewLine, batch.Remaining());
            videoPath = batch.LastVideo;
            openVideo.Enabled = openFolder.Enabled = videoPath != null && File.Exists(videoPath);
            Notify(batch.NotificationText());
            UpdateButtons();
            if (close) Close();
        }

        async Task StopAsync()
        {
            if (!state.CancelRequested()) return;
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }

        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            CloseAction action = state.CloseRequested();
            if (action == CloseAction.CloseNow) { SaveSettings(); return; }
            e.Cancel = true;
            if (action == CloseAction.Wait) return;
            if (MessageBox.Show(this, "Stop the conversion?", "fc2mp4", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            if (!state.CloseConfirmed()) { Post(Close); return; }
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }

        // ---- Done notification (only when the window is in the background) ----

        [StructLayout(LayoutKind.Sequential)]
        struct FlashInfo
        {
            public uint Size;
            public IntPtr Window;
            public uint Flags;
            public uint Count;
            public uint Timeout;
        }

        [DllImport("user32.dll")]
        static extern bool FlashWindowEx(ref FlashInfo info);

        const uint FlashAll = 3, FlashUntilForeground = 12;

        void Notify(string text)
        {
            if (text == null || ActiveForm == this) return;
            var info = new FlashInfo { Size = (uint)Marshal.SizeOf(typeof(FlashInfo)), Window = Handle, Flags = FlashAll | FlashUntilForeground };
            FlashWindowEx(ref info);
            notifier.Visible = true;
            notifier.ShowBalloonTip(5000, "fc2mp4", text, ToolTipIcon.Info);
        }

        // ---- Updates ----

        async Task CheckForUpdateAsync()
        {
            if (Updater.IsLocalBuild(windowVersion)) return;
            Version latest = await Task.Run(() => FetchLatestVersion());
            Post(() => { latestVersion = latest; ShowUpdateBar(); });
        }

        static Version FetchLatestVersion()
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; // GitHub refuses older TLS
                var request = (HttpWebRequest)WebRequest.Create(UpdateCheck.ApiUrl);
                request.UserAgent = "fc2mp4"; // required by the GitHub API
                request.Accept = "application/vnd.github+json";
                request.Timeout = 5_000;
                request.ReadWriteTimeout = 5_000;
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return UpdateCheck.ParseLatestTag(reader.ReadToEnd());
            }
            catch (Exception) { return null; }
        }

        void ShowUpdateBar()
        {
            if (!Updater.Offer(latestVersion, windowVersion) || updateDismissed) { updateBar.Visible = false; return; }
            updateBar.Visible = true;
            updateGitHub.Visible = updateError != null;
            updateNow.Text = updateError != null ? "Try again" : "Update now";
            updateNow.Enabled = !state.Running && !updating;
            updateLater.Enabled = !updating;
            if (updating) return; // the download shows its own progress
            string offer = "fc2mp4 v" + latestVersion + " is available.";
            updateText.Text = updateError ?? (state.Running ? offer + " Update after this conversion finishes." : offer);
        }

        async void UpdateNow()
        {
            updating = true;
            updateError = null;
            UpdateButtons();
            updateText.Text = "Downloading the update…";
            Version version = latestVersion;
            string setup = Path.Combine(Path.GetTempPath(), "fc2mp4-setup-v" + version + ".exe");
            string error = await Task.Run(() => Download(Updater.SetupUrl(version), setup, percent => Post(() => updateText.Text = "Downloading the update… " + percent + "%")));
            if (error == null)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(setup, Updater.SilentArgs) { UseShellExecute = true });
                    Close(); // the installer replaces the files and reopens the window
                    return;
                }
                catch (Exception e) { error = "The update couldn't be started: " + e.Message; }
            }
            updating = false;
            updateError = error;
            UpdateButtons();
        }

        static string Download(string url, string path, Action<int> progress)
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.UserAgent = "fc2mp4";
                request.Timeout = 15_000;
                request.ReadWriteTimeout = 30_000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var input = response.GetResponseStream())
                using (var file = File.Create(path))
                {
                    long expected = response.ContentLength, total = 0;
                    var buffer = new byte[81920];
                    var head = new byte[2];
                    int headLength = 0, last = -1, read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (headLength < 2)
                        {
                            int take = Math.Min(2 - headLength, read);
                            Array.Copy(buffer, 0, head, headLength, take);
                            headLength += take;
                        }
                        file.Write(buffer, 0, read);
                        total += read;
                        if (expected > 0)
                        {
                            int percent = (int)(total * 100 / expected);
                            if (percent != last) { last = percent; progress(percent); }
                        }
                    }
                    if (headLength < 2) head = new byte[0];
                    return Updater.CheckDownload(head, total, expected);
                }
            }
            catch (Exception e) { return "The update couldn't be downloaded: " + e.Message; }
        }
    }
}
