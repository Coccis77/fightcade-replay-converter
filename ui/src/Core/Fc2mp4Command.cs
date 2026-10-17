using System.Collections.Generic;

namespace Fc2mp4Ui
{
    public static class Fc2mp4Command
    {
        // fc2mp4.exe <link> -o <output folder> [--fightcade-dir <folder>] [--encoder <name>] --stop-on-stdin-close
        public static List<string> Arguments(string link, string outputFolder, string fightcadeFolder, string encoder = "x264")
        {
            var args = new List<string> { link.Trim(), "-o", outputFolder.Trim() };
            if (!string.IsNullOrWhiteSpace(fightcadeFolder))
            {
                args.Add("--fightcade-dir");
                args.Add(fightcadeFolder.Trim());
            }
            string name = Encoders.Normalize(encoder);
            if (name != "x264")
            {
                args.Add("--encoder");
                args.Add(name);
            }
            args.Add("--stop-on-stdin-close");
            return args;
        }
    }
}
