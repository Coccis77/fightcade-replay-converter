using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    public sealed class MainForm : Form
    {
        const string HelpText = "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).";

        readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fc2mp4-ui", "settings.txt");
        readonly Version windowVersion = typeof(MainForm).Assembly.GetName().Version;
        readonly ConversionRunner runner = new ConversionRunner();
        readonly RunState state = new RunState();
        readonly List<Button> browseButtons = new List<Button>();

        readonly TextBox link = new TextBox { Dock = DockStyle.Fill };
        readonly Button convert = new Button { Text = "Convert", AutoSize = true };
        readonly Button cancel = new Button { Text = "Cancel", AutoSize = true, Enabled = false };
        readonly Label status = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
        readonly TextBox console = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font(FontFamily.GenericMonospace, 9f), BackColor = SystemColors.Window };
        readonly Button openVideo = new Button { Text = "Open video", AutoSize = true, Enabled = false };
        readonly Button openFolder = new Button { Text = "Open folder", AutoSize = true, Enabled = false };
        readonly TextBox exe = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox fightcade = new TextBox { Dock = DockStyle.Fill };
        readonly TextBox output = new TextBox { Dock = DockStyle.Fill };
        readonly ComboBox encoder = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
        readonly Label exeVersionLabel = new Label { AutoSize = true, Anchor = AnchorStyles.Left };
        readonly LinkLabel downloadLink = new LinkLabel { Text = "Download the latest fc2mp4", AutoSize = true, Anchor = AnchorStyles.Left };

        Version exeVersion;
        Version latestVersion;

        OutputLog log = new OutputLog();
        List<string> stdout = new List<string>();
        List<string> stderr = new List<string>();
        bool exeReady;
        string videoPath;

        public MainForm()
        {
            Text = "fc2mp4";
            MinimumSize = new Size(640, 480);
            Size = new Size(760, 560);
            StartPosition = FormStartPosition.CenterScreen;
            BuildLayout();

            string besideMe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fc2mp4.exe");
            string defaultOutput = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Videos", "Fightcade");
            var settings = Settings.Load(settingsPath, File.Exists(besideMe) ? besideMe : "", defaultOutput);
            exe.Text = settings.Exe;
            fightcade.Text = settings.FightcadeFolder;
            encoder.Items.AddRange(Encoders.Labels);
            encoder.SelectedIndex = Array.IndexOf(Encoders.Names, settings.Encoder);
            output.Text = settings.OutputFolder;

            AcceptButton = convert;
            link.TextChanged += (s, e) => UpdateButtons();
            exe.Leave += (s, e) => { if (!state.Running) CheckExe(); };
            convert.Click += (s, e) => StartConversion();
            cancel.Click += async (s, e) => await StopAsync();
            openVideo.Click += (s, e) => { if (videoPath != null) Process.Start(new ProcessStartInfo(videoPath) { UseShellExecute = true }); };
            openFolder.Click += (s, e) => { if (videoPath != null) Process.Start("explorer.exe", "/select," + WindowsArgs.Quote(videoPath)); };
            runner.StderrLine += line => Post(() => OnStderr(line));
            runner.StdoutLine += line => Post(() => stdout.Add(line));
            runner.Exited += (code, forced) => Post(() => OnExited(code, forced));
            downloadLink.LinkClicked += (s, e) => OpenUrl(UpdateCheck.ReleasesUrl);
            Shown += (s, e) => { CheckExe(); link.Focus(); _ = CheckForUpdateAsync(); };
            FormClosing += OnClosing;
        }

        void BuildLayout()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10) };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); // the only column fills the window
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // link
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // buttons
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));   // status
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // console
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // open buttons
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));       // settings

            var linkRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            linkRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            linkRow.Controls.Add(new Label { Text = "Replay link", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 0);
            linkRow.Controls.Add(link, 1, 0);
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
            AddPathRow(grid, 0, "fc2mp4.exe", exe, BrowseExe);
            AddPathRow(grid, 1, "Fightcade folder", fightcade, () => BrowseFolder(fightcade, "Fightcade folder (the one that contains emulator\\fbneo)"));
            AddPathRow(grid, 2, "Output folder", output, () => BrowseFolder(output, "Folder for the videos"));
            var help = new Label { Text = HelpText, AutoSize = true, MaximumSize = new Size(680, 0), ForeColor = SystemColors.GrayText, Padding = new Padding(0, 6, 0, 0) };
            var versionRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0) };
            versionRow.Controls.Add(exeVersionLabel);
            versionRow.Controls.Add(downloadLink);
            grid.Controls.Add(new Label { Text = "Encoder", AutoSize = true, Anchor = AnchorStyles.Left }, 0, 3);
            grid.Controls.Add(encoder, 1, 3);
            grid.SetColumnSpan(encoder, 2);
            grid.Controls.Add(versionRow, 1, 4);
            grid.SetColumnSpan(versionRow, 2);
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

        void BrowseExe()
        {
            using (var dialog = new OpenFileDialog { Filter = "fc2mp4.exe|fc2mp4.exe|Programs (*.exe)|*.exe", Title = "Choose fc2mp4.exe" })
            {
                if (File.Exists(exe.Text)) dialog.InitialDirectory = Path.GetDirectoryName(exe.Text);
                if (dialog.ShowDialog(this) == DialogResult.OK) { exe.Text = dialog.FileName; CheckExe(); }
            }
        }

        void BrowseFolder(TextBox box, string description)
        {
            using (var dialog = new FolderBrowserDialog { Description = description, SelectedPath = box.Text })
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
        }

        void CheckExe()
        {
            if (state.Running) return; // never overwrite the progress or run fc2mp4 --version mid-conversion
            exeReady = false;
            exeVersion = null;
            if (!File.Exists(exe.Text.Trim()))
            {
                status.Text = "Choose fc2mp4.exe in Settings";
                exeVersionLabel.Text = "";
                downloadLink.Visible = true;
                UpdateButtons();
                return;
            }
            string versionOutput = ConversionRunner.ReadVersion(exe.Text.Trim());
            exeVersion = VersionCheck.Parse(versionOutput);
            var verdict = VersionCheck.Evaluate(windowVersion, versionOutput);
            exeReady = verdict.Status != VersionStatus.TooOld;
            status.Text = verdict.Status == VersionStatus.Ok ? "Ready" : verdict.Message;
            ShowVersionInfo();
            UpdateButtons();
        }

        // The version line under the exe path, and the newer-release notice in the status line
        // (only over "Ready": a problem message or a running conversion keeps the status).
        void ShowVersionInfo()
        {
            if (File.Exists(exe.Text.Trim())) exeVersionLabel.Text = UpdateCheck.VersionLabel(exeVersion, latestVersion);
            downloadLink.Visible = UpdateCheck.ShowDownloadLink(latestVersion, exeVersion, windowVersion, exeReady);
            string notice = UpdateCheck.Notice(latestVersion, exeVersion, windowVersion);
            if (notice != null && !state.Running && status.Text == "Ready") status.Text = notice;
        }

        // Asks GitHub for the latest release once, in the background; offline or rate-limited means no notice.
        async Task CheckForUpdateAsync()
        {
            Version latest = await Task.Run(() => FetchLatestVersion());
            Post(() => { latestVersion = latest; ShowVersionInfo(); });
        }

        static Version FetchLatestVersion()
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; // GitHub refuses older TLS
                var request = (HttpWebRequest)WebRequest.Create(UpdateCheck.ApiUrl);
                request.UserAgent = "fc2mp4-ui"; // required by the GitHub API
                request.Accept = "application/vnd.github+json";
                request.Timeout = 5_000;
                request.ReadWriteTimeout = 5_000;
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return UpdateCheck.ParseLatestTag(reader.ReadToEnd());
            }
            catch (Exception) { return null; }
        }

        void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch (Exception e) { status.Text = "Could not open the browser: " + e.Message; }
        }

        // Events from fc2mp4 arrive on other threads; once the window is gone they are dropped.
        void Post(Action action)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { } // includes ObjectDisposedException
        }

        void UpdateButtons()
        {
            bool running = state.Running;
            convert.Enabled = exeReady && !running && link.Text.Trim().Length > 0;
            cancel.Enabled = running && !state.Stopping;
            foreach (var box in new[] { link, exe, fightcade, output }) box.ReadOnly = running;
            foreach (var button in browseButtons) button.Enabled = !running;
            encoder.Enabled = !running;
        }

        async System.Threading.Tasks.Task StopAsync()
        {
            if (!state.CancelRequested()) return;
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }

        string SelectedEncoder() => encoder.SelectedIndex >= 0 ? Encoders.Names[encoder.SelectedIndex] : "x264";

        Settings CurrentSettings() => new Settings { Exe = exe.Text.Trim(), FightcadeFolder = fightcade.Text.Trim(), OutputFolder = output.Text.Trim(), Encoder = SelectedEncoder() };

        void SaveSettings()
        {
            try { CurrentSettings().Save(settingsPath); } catch (Exception) { }
        }

        void StartConversion()
        {
            if (!convert.Enabled) return;
            string folderError = OutputFolder.Ensure(output.Text);
            if (folderError != null) { status.Text = "Failed: " + folderError; return; }
            SaveSettings();
            log = new OutputLog();
            stdout = new List<string>();
            stderr = new List<string>();
            videoPath = null;
            console.Text = "";
            openVideo.Enabled = openFolder.Enabled = false;
            try
            {
                runner.Start(exe.Text.Trim(), Fc2mp4Command.Arguments(link.Text, output.Text, fightcade.Text, SelectedEncoder()));
            }
            catch (Exception e)
            {
                status.Text = "Failed: could not start fc2mp4.exe: " + e.Message;
                return;
            }
            state.Started();
            status.Text = "Starting…";
            UpdateButtons();
        }

        void OnStderr(string line)
        {
            stderr.Add(line);
            log.Add(line);
            console.Text = log.Text;
            console.SelectionStart = console.TextLength;
            console.ScrollToCaret();
            if (state.ShowsProgress && log.Progress != null && line == log.Progress) status.Text = line;
        }

        void OnExited(int code, bool forced)
        {
            bool close = state.Finished();
            var outcome = RunOutcome.From(code, forced, stdout, stderr);
            status.Text = outcome.Message;
            videoPath = outcome.Kind == OutcomeKind.Done ? outcome.VideoPath : null;
            openVideo.Enabled = openFolder.Enabled = videoPath != null && File.Exists(videoPath);
            UpdateButtons();
            if (close) Close();
        }

        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            CloseAction action = state.CloseRequested();
            if (action == CloseAction.CloseNow) { SaveSettings(); return; }
            e.Cancel = true;
            if (action == CloseAction.Wait) return; // already stopping, closes when fc2mp4 has exited
            if (MessageBox.Show(this, "Stop the conversion?", "fc2mp4", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            if (!state.CloseConfirmed()) { Post(Close); return; } // fc2mp4 finished while the question was open
            status.Text = "Stopping…";
            UpdateButtons();
            await runner.CancelAsync();
        }
    }
}
