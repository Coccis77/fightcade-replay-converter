using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class EncodersTests
    {
        [Fact]
        public void OffersAutomaticFirstThenEveryWindowsEncoder()
        {
            Assert.Equal(new[] { "auto", "x264", "nvenc", "qsv", "amf", "mf" }, Encoders.Names);
            Assert.Equal(Encoders.Names.Length, Encoders.Labels.Length);
            Assert.Equal(Encoders.Names.Length, Encoders.Descriptions.Length);
            Assert.Equal("Automatic (default)", Encoders.Labels[0]);
        }

        [Fact]
        public void ExplainsEachChoice()
        {
            Assert.Equal("Uses your NVIDIA graphics card (nvenc) when it can, otherwise x264. Recommended.", Encoders.Describe("auto"));
            Assert.Equal("Uses your processor. Works on every PC; the smallest files.", Encoders.Describe("x264"));
            Assert.Contains("Intel graphics drivers", Encoders.Describe("qsv"));
            Assert.Contains("AMD graphics drivers", Encoders.Describe("amf"));
            Assert.Equal(Encoders.Describe("auto"), Encoders.Describe("videotoolbox")); // not offered on Windows
        }
    }
}
