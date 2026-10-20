using System;

namespace Fc2mp4Ui
{
    // The encoder choices offered in Settings (fc2mp4's --encoder values; videotoolbox is macOS-only).
    // x264 is fc2mp4's default; an unknown or removed choice (the old "auto") becomes x264.
    public static class Encoders
    {
        public static readonly string[] Names = { "x264", "nvenc", "qsv", "amf", "mf" };
        public static readonly string[] Labels =
        {
            "x264 (CPU, default)",
            "NVIDIA (nvenc)",
            "Intel (qsv)",
            "AMD (amf)",
            "Windows (mf)",
        };
        public static readonly string[] Descriptions =
        {
            "Uses your processor. Works on every PC; the smallest files. Recommended.",
            "NVIDIA graphics cards. Faster than x264 with a good NVIDIA graphics card (about 25% on a recent one), same quality, slightly bigger files.",
            "Intel graphics (QuickSync). Needs Intel graphics drivers. Not tested yet.",
            "AMD graphics cards. Needs AMD graphics drivers. Not tested yet.",
            "Windows' own encoder, any graphics card. Usually not faster than x264, bigger files.",
        };

        public static string Normalize(string name) => Array.IndexOf(Names, name) >= 0 ? name : "x264";

        public static string Describe(string name) => Descriptions[Array.IndexOf(Names, Normalize(name))];
    }
}
