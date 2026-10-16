using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Fc2mp4Ui
{
    // Builds a Windows command line that the program receives exactly as given (Microsoft C runtime
    // rules, also used by Node.js): paths with spaces, a trailing backslash or quotes stay intact.
    public static class WindowsArgs
    {
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') sb.Append('\\', backslashes * 2 + 1);
                else sb.Append('\\', backslashes);
                sb.Append(c);
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string Join(IEnumerable<string> args) => string.Join(" ", args.Select(Quote));
    }
}
