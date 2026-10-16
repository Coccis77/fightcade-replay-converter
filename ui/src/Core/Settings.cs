using System;
using System.IO;
using System.Text;

namespace Fc2mp4Ui
{
    // %APPDATA%\fc2mp4-ui\settings.txt: exe=, fightcade=, output= (the link is never saved).
    public sealed class Settings
    {
        public string Exe { get; set; } = "";
        public string FightcadeFolder { get; set; } = "";
        public string OutputFolder { get; set; } = "";

        public static Settings Load(string path, string defaultExe, string defaultOutput)
        {
            var s = new Settings { Exe = defaultExe, OutputFolder = defaultOutput };
            string[] lines;
            try { lines = File.ReadAllLines(path, Encoding.UTF8); }
            catch (Exception) { return s; }
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key == "exe" && value.Length > 0) s.Exe = value;
                else if (key == "fightcade") s.FightcadeFolder = value;
                else if (key == "output" && value.Length > 0) s.OutputFolder = value;
            }
            return s;
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=" + Exe + "\nfightcade=" + FightcadeFolder + "\noutput=" + OutputFolder + "\n", new UTF8Encoding(false));
        }
    }
}
