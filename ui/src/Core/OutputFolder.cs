using System;
using System.IO;

namespace Fc2mp4Ui
{
    // Created before fc2mp4 runs: fc2mp4 reads a missing folder given without a trailing "\" as a file name.
    public static class OutputFolder
    {
        public static string Ensure(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder)) return "Choose an output folder in Settings";
            try
            {
                Directory.CreateDirectory(folder.Trim());
                return null;
            }
            catch (Exception e)
            {
                return "Cannot create the output folder " + folder.Trim() + ": " + e.Message;
            }
        }
    }
}
