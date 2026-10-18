using System;
using System.Collections.Generic;

namespace Fc2mp4Ui
{
    // The links box: one replay link per line; blank lines and repeats are ignored, order is kept.
    public static class LinkList
    {
        public static List<string> Parse(string text)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var links = new List<string>();
            foreach (string raw in (text ?? "").Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string link = raw.Trim();
                if (link.Length > 0 && seen.Add(link)) links.Add(link);
            }
            return links;
        }
    }
}
