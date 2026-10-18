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
            var s = Settings.Load(TempFile(), @"C:\Videos\Fightcade");
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal(@"C:\Videos\Fightcade", s.OutputFolder);
            Assert.Equal("auto", s.Encoder);
            Assert.Equal("", s.LastVersion);
        }

        [Fact]
        public void AnUnknownEncoderFallsBackToAutomatic()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "encoder=divx\n");
            Assert.Equal("auto", Settings.Load(path, "o").Encoder);
        }

        [Fact]
        public void SavesAndLoadsBack_CreatingTheFolder_EvenWithEqualsSignsInPaths()
        {
            string path = TempFile();
            new Settings { FightcadeFolder = @"D:\Fight cade", OutputFolder = @"C:\a=b\Out", Encoder = "qsv", LastVersion = "0.18.0" }.Save(path);
            var s = Settings.Load(path, "y");
            Assert.Equal(@"D:\Fight cade", s.FightcadeFolder);
            Assert.Equal(@"C:\a=b\Out", s.OutputFolder);
            Assert.Equal("qsv", s.Encoder);
            Assert.Equal("0.18.0", s.LastVersion);
        }

        [Fact]
        public void EmptyOutputFallsBackToTheDefault_EmptyFightcadeStaysEmpty()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "fightcade=\noutput=\nunknown=1\ngarbage line\n");
            var s = Settings.Load(path, "defOut");
            Assert.Equal("", s.FightcadeFolder);
            Assert.Equal("defOut", s.OutputFolder);
        }

        [Fact]
        public void AnUnreadableFileMeansDefaults()
        {
            string dir = Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir); // a folder where the file should be
            Assert.Equal("defOut", Settings.Load(dir, "defOut").OutputFolder);
        }

        [Fact]
        public void ASettingsFileFromTheTwoExeSetupStillLoads()
        {
            string path = TempFile();
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "exe=C:\\Tools\\fc2mp4.exe\nfightcade=D:\\FC\noutput=E:\\Out\nencoder=nvenc\n");
            var s = Settings.Load(path, "defOut");
            Assert.Equal(@"D:\FC", s.FightcadeFolder);
            Assert.Equal(@"E:\Out", s.OutputFolder);
            Assert.Equal("nvenc", s.Encoder);
            Assert.Equal("", s.LastVersion);
        }
    }
}
