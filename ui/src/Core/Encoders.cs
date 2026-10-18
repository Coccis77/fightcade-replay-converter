using System;

namespace Fc2mp4Ui
{
    // The encoder choices offered in Settings (fc2mp4's --encoder values; videotoolbox is macOS-only).
    // "auto" is fc2mp4's default: NVIDIA's nvenc when the PC has it, otherwise x264.
    public static class Encoders
    {
        public static readonly string[] Names = { "auto", "x264", "nvenc", "qsv", "amf", "mf" };
        public static readonly string[] Labels =
        {
            "Automatic (default)",
            "x264 (CPU)",
            "NVIDIA (nvenc)",
            "Intel (qsv)",
            "AMD (amf)",
            "Windows (mf)",
        };
        public static readonly string[] Descriptions =
        {
            "Uses your NVIDIA graphics card (nvenc) when it can, otherwise x264. Recommended.",
            "Uses your processor. Works on every PC; the smallest files.",
            "NVIDIA graphics cards. About 25% faster than x264, same quality, slightly bigger files.",
            "Intel graphics (QuickSync). Needs Intel graphics drivers. Not tested yet.",
            "AMD graphics cards. Needs AMD graphics drivers. Not tested yet.",
            "Windows' own encoder, any graphics card. Usually not faster than x264, bigger files.",
        };

        public static string Normalize(string name) => Array.IndexOf(Names, name) >= 0 ? name : "auto";

        public static string Describe(string name) => Descriptions[Array.IndexOf(Names, Normalize(name))];
    }
}
