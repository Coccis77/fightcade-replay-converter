using System;

namespace Fc2mp4Ui
{
    // fc2mp4's --encoder values, with the label shown in Settings. x264 (CPU) is fc2mp4's default.
    public static class Encoders
    {
        public static readonly string[] Names = { "x264", "nvenc", "qsv", "amf", "mf", "videotoolbox" };
        public static readonly string[] Labels =
        {
            "x264 (CPU, default)",
            "NVIDIA (nvenc)",
            "Intel QuickSync (qsv)",
            "AMD (amf)",
            "Windows, any GPU (mf)",
            "macOS (videotoolbox)",
        };

        public static string Normalize(string name) => Array.IndexOf(Names, name) >= 0 ? name : "x264";
    }
}
