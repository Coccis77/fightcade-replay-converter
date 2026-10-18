using System;
using System.IO;
using System.Text;

namespace Fc2mp4Ui
{
    // %APPDATA%\fc2mp4-ui\settings.txt: fightcade=, output=, encoder=, last= (the version that last ran).
    // The link is never saved; exe= (from the two-exe setup) is ignored.
    public sealed class Settings
    {
        public string FightcadeFolder { get; set; } = "";
        public string OutputFolder { get; set; } = "";
        public string Encoder { get; set; } = "auto";
        public string LastVersion { get; set; } = "";

        public static Settings Load(string path, string defaultOutput)
        {
            var s = new Settings { OutputFolder = defaultOutput };
            string[] lines;
            try { lines = File.ReadAllLines(path, Encoding.UTF8); }
            catch (Exception) { return s; }
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key == "fightcade") s.FightcadeFolder = value;
                else if (key == "output" && value.Length > 0) s.OutputFolder = value;
                else if (key == "encoder") s.Encoder = Encoders.Normalize(value);
                else if (key == "last") s.LastVersion = value;
            }
            return s;
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "fightcade=" + FightcadeFolder + "\noutput=" + OutputFolder + "\nencoder=" + Encoder + "\nlast=" + LastVersion + "\n", new UTF8Encoding(false));
        }
    }
}
