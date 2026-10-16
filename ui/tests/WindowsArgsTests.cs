using System.Collections.Generic;
using System.Text;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class WindowsArgsTests
    {
        [Theory]
        [InlineData("plain", "plain")]
        [InlineData(@"C:\Fightcade", @"C:\Fightcade")]
        [InlineData("", "\"\"")]
        [InlineData(@"C:\My Games\Fightcade", "\"C:\\My Games\\Fightcade\"")]
        [InlineData(@"C:\My Games\Fightcade\", "\"C:\\My Games\\Fightcade\\\\\"")]
        [InlineData("a\"b", "\"a\\\"b\"")]
        public void QuotesOnlyWhenNeeded(string arg, string expected)
        {
            Assert.Equal(expected, WindowsArgs.Quote(arg));
        }

        // What the program receives must be exactly what we meant to send (Microsoft C runtime rules,
        // which Node.js follows on Windows).
        [Fact]
        public void RoundTripsThroughTheWindowsParsingRules()
        {
            var args = new List<string>
            {
                "https://replay.fightcade.com/fbneo/garou/1791766846976-7757",
                "-o", @"C:\Users\Jean Pierre\Videos\Fightcade\",
                "--fightcade-dir", @"D:\Games\Fight cade\",
                "with \"quotes\" inside", @"back\\slashes\", "", "tab\there",
            };
            Assert.Equal(args, Parse(WindowsArgs.Join(args)));
        }

        static List<string> Parse(string commandLine)
        {
            var result = new List<string>();
            var current = new StringBuilder();
            bool inQuotes = false, inArg = false;
            for (int i = 0; i < commandLine.Length; i++)
            {
                char c = commandLine[i];
                if (c == '\\')
                {
                    int n = 0;
                    while (i < commandLine.Length && commandLine[i] == '\\') { n++; i++; }
                    if (i < commandLine.Length && commandLine[i] == '"')
                    {
                        current.Append('\\', n / 2);
                        if (n % 2 == 1) current.Append('"');
                        else { inQuotes = !inQuotes; }
                    }
                    else { current.Append('\\', n); i--; }
                    inArg = true;
                }
                else if (c == '"') { inQuotes = !inQuotes; inArg = true; }
                else if ((c == ' ' || c == '\t') && !inQuotes)
                {
                    if (inArg) { result.Add(current.ToString()); current.Clear(); inArg = false; }
                }
                else { current.Append(c); inArg = true; }
            }
            if (inArg) result.Add(current.ToString());
            return result;
        }
    }
}
