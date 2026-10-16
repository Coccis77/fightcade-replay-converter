using System.Collections.Generic;

namespace Fc2mp4Ui
{
    public static class Fc2mp4Command
    {
        // fc2mp4.exe <link> -o <output folder> [--fightcade-dir <folder>] --stop-on-stdin-close
        public static List<string> Arguments(string link, string outputFolder, string fightcadeFolder)
        {
            var args = new List<string> { link.Trim(), "-o", outputFolder.Trim() };
            if (!string.IsNullOrWhiteSpace(fightcadeFolder))
            {
                args.Add("--fightcade-dir");
                args.Add(fightcadeFolder.Trim());
            }
            args.Add("--stop-on-stdin-close");
            return args;
        }
    }
}
