using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    public sealed class MainForm : Form
    {
        const string HelpText = "Needs Fightcade 2 with the game opened once. ffmpeg and the emulator download automatically on the first conversion (about a minute).";

        readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fc2mp4-ui", "settings.txt");
        readonly Version windowVersion = typeof(MainForm).Assembly.GetName().Version;
        readonly ConversionRunner runner = new ConversionRunner();

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

        OutputLog log = new OutputLog();
        List<string> stdout = new List<string>();
        List<string> stderr = new List<string>();
        bool exeReady;
        bool closeWhenStopped;
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
            output.Text = settings.OutputFolder;

            AcceptButton = convert;
            link.TextChanged += (s, e) => UpdateButtons();
            exe.Leave += (s, e) => CheckExe();
            convert.Click += (s, e) => StartConversion();
            cancel.Click += async (s, e) => { status.Text = "Stopping…"; cancel.Enabled = false; await runner.CancelAsync(); };
            openVideo.Click += (s, e) => { if (videoPath != null) Process.Start(new ProcessStartInfo(videoPath) { UseShellExecute = true }); };
            openFolder.Click += (s, e) => { if (videoPath != null) Process.Start("explorer.exe", "/select," + WindowsArgs.Quote(videoPath)); };
            runner.StderrLine += line => BeginInvoke(new Action(() => OnStderr(line)));
            runner.StdoutLine += line => BeginInvoke(new Action(() => stdout.Add(line)));
            runner.Exited += (code, forced) => BeginInvoke(new Action(() => OnExited(code, forced)));
            Shown += (s, e) => { CheckExe(); link.Focus(); };
            FormClosing += OnClosing;
        }

        void BuildLayout()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(10) };
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
            grid.Controls.Add(help, 0, 3);
            grid.SetColumnSpan(help, 3);
            group.Controls.Add(grid);
            root.Controls.Add(group);

            Controls.Add(root);
        }

        static void AddPathRow(TableLayoutPanel grid, int row, string label, TextBox box, Action browse)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
            grid.Controls.Add(box, 1, row);
            var button = new Button { Text = "Browse…", AutoSize = true };
            button.Click += (s, e) => browse();
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
            exeReady = false;
            if (!File.Exists(exe.Text.Trim())) { status.Text = "Choose fc2mp4.exe in Settings"; UpdateButtons(); return; }
            var verdict = VersionCheck.Evaluate(windowVersion, ConversionRunner.ReadVersion(exe.Text.Trim()));
            exeReady = verdict.Status != VersionStatus.TooOld;
            status.Text = verdict.Status == VersionStatus.Ok ? "Ready" : verdict.Message;
            UpdateButtons();
        }

        void UpdateButtons()
        {
            bool running = runner.Running;
            convert.Enabled = exeReady && !running && link.Text.Trim().Length > 0;
            cancel.Enabled = running;
            foreach (var box in new[] { link, exe, fightcade, output }) box.ReadOnly = running;
        }

        Settings CurrentSettings() => new Settings { Exe = exe.Text.Trim(), FightcadeFolder = fightcade.Text.Trim(), OutputFolder = output.Text.Trim() };

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
                runner.Start(exe.Text.Trim(), Fc2mp4Command.Arguments(link.Text, output.Text, fightcade.Text));
            }
            catch (Exception e)
            {
                status.Text = "Failed: could not start fc2mp4.exe: " + e.Message;
                return;
            }
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
            if (log.Progress != null && line == log.Progress) status.Text = line;
        }

        void OnExited(int code, bool forced)
        {
            var outcome = RunOutcome.From(code, forced, stdout, stderr);
            status.Text = outcome.Message;
            videoPath = outcome.Kind == OutcomeKind.Done ? outcome.VideoPath : null;
            openVideo.Enabled = openFolder.Enabled = videoPath != null && File.Exists(videoPath);
            UpdateButtons();
            if (closeWhenStopped) Close();
        }

        async void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!runner.Running) { SaveSettings(); return; }
            e.Cancel = true;
            if (closeWhenStopped) return; // already stopping
            if (MessageBox.Show(this, "Stop the conversion?", "fc2mp4", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            closeWhenStopped = true;
            status.Text = "Stopping…";
            cancel.Enabled = false;
            await runner.CancelAsync();
        }
    }
}
