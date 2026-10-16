using System.IO;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class SettingsTests
    {
        static string TempFile() => Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName(), "settings.txt");

        [Fact]
        public void UsesTheDefaultsWithoutAFile()
        {
            var s = Settings.Load(TempFile(), @"C:\Tools\fc2mp4.exe", @"C:\Videos\Fightcade");
            Assert.Equal(@"C:\Tools\fc2mp4.exe", s.Exe);
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal(@"C:\Videos\Fightcade", s.OutputFolder);
        }

        [Fact]
        public void SavesAndLoadsBack_CreatingTheFolder_EvenWithEqualsSignsInPaths()
        {
            string path = TempFile();
            new Settings { Exe = @"C:\a=b\fc2mp4.exe", FightcadeFolder = @"D:\Fight cade", OutputFolder = @"E:\Out" }.Save(path);
            var s = Settings.Load(path, "x", "y");
            Assert.Equal(@"C:\a=b\fc2mp4.exe", s.Exe);
            Assert.Equal(@"D:\Fight cade", s.FightcadeFolder);
            Assert.Equal(@"E:\Out", s.OutputFolder);
        }

        [Fact]
        public void EmptyExeOrOutputFallBackToTheDefaults_EmptyFightcadeStaysEmpty()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=\nfightcade=\noutput=\nunknown=1\ngarbage line\n");
            var s = Settings.Load(path, "defExe", "defOut");
            Assert.Equal("defExe", s.Exe);
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal("defOut", s.OutputFolder);
        }

        [Fact]
        public void AnUnreadableFileMeansDefaults()
        {
            string dir = Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir); // a folder where the file should be
            var s = Settings.Load(dir, "defExe", "defOut");
            Assert.Equal("defExe", s.Exe);
        }
    }
}
