using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class EncodersTests
    {
        [Fact]
        public void OffersX264FirstThenEveryWindowsEncoder()
        {
            Assert.Equal(new[] { "x264", "nvenc", "qsv", "amf", "mf" }, Encoders.Names);
            Assert.Equal(Encoders.Names.Length, Encoders.Labels.Length);
            Assert.Equal(Encoders.Names.Length, Encoders.Descriptions.Length);
            Assert.Equal("x264 (CPU, default)", Encoders.Labels[0]);
        }

        [Fact]
        public void ExplainsEachChoice()
        {
            Assert.Equal("Uses your processor. Works on every PC; the smallest files. Recommended.", Encoders.Describe("x264"));
            Assert.Contains("good NVIDIA graphics card", Encoders.Describe("nvenc"));
            Assert.Contains("Intel graphics drivers", Encoders.Describe("qsv"));
            Assert.Contains("AMD graphics drivers", Encoders.Describe("amf"));
            Assert.Equal(Encoders.Describe("x264"), Encoders.Describe("videotoolbox")); // not offered on Windows
            Assert.Equal(Encoders.Describe("x264"), Encoders.Describe("auto")); // removed choice
        }
    }
}
