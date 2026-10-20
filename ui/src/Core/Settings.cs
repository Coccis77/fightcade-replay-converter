using System;
using System.IO;
using System.Text;

namespace Fc2mp4Ui
{
    // %APPDATA%\fc2mp4-ui\settings.txt: fightcade=, output=, encoder=, last= (the version that last ran),
    // window= (x,y,width,height) and divider= (height of the log above Settings).
    // The link is never saved; exe= (from the two-exe setup) is ignored.
    public sealed class Settings
    {
        public string FightcadeFolder { get; set; } = "";
        public string OutputFolder { get; set; } = "";
        public string Encoder { get; set; } = "x264";
        public string LastVersion { get; set; } = "";
        public string Window { get; set; } = "";
        public int Divider { get; set; }

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
                else if (key == "window") s.Window = value;
                else if (key == "divider" && int.TryParse(value, out int divider) && divider > 0) s.Divider = divider;
            }
            return s;
        }

        // x, y, width, height of a saved window, or null when missing or not a usable window.
        public static int[] ParseWindow(string text)
        {
            string[] parts = (text ?? "").Split(',');
            if (parts.Length != 4) return null;
            var values = new int[4];
            for (int i = 0; i < 4; i++)
                if (!int.TryParse(parts[i].Trim(), out values[i])) return null;
            return values[2] >= 300 && values[3] >= 300 ? values : null;
        }

        public void Save(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "fightcade=" + FightcadeFolder + "\noutput=" + OutputFolder + "\nencoder=" + Encoder + "\nlast=" + LastVersion + "\nwindow=" + Window + "\ndivider=" + Divider + "\n", new UTF8Encoding(false));
        }
    }
}
