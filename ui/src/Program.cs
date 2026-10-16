using System;
using System.Windows.Forms;

namespace Fc2mp4Ui
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.Run(new Form { Text = "fc2mp4" });
        }
    }
}
