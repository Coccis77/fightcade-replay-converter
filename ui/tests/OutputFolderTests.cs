using System.IO;
using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class OutputFolderTests
    {
        [Fact]
        public void CreatesAMissingFolder()
        {
            string dir = Path.Combine(Path.GetTempPath(), "fc2mp4-ui-" + Path.GetRandomFileName(), "Videos", "Fightcade");
            Assert.Null(OutputFolder.Ensure(dir));
            Assert.True(Directory.Exists(dir));
        }

        [Fact]
        public void ExplainsAFolderThatCannotBeCreated()
        {
            string file = Path.GetTempFileName(); // a file: nothing can be created inside it
            string error = OutputFolder.Ensure(Path.Combine(file, "sub"));
            Assert.StartsWith("Cannot create the output folder " + Path.Combine(file, "sub") + ": ", error);
        }

        [Fact]
        public void RefusesAnEmptyField()
        {
            Assert.Equal("Choose an output folder in Settings", OutputFolder.Ensure("  "));
        }
    }
}
