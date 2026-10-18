using Xunit;

namespace Fc2mp4Ui.Tests
{
    public class LinkListTests
    {
        [Fact]
        public void OneLinkPerLineTrimmedWithoutBlanksOrRepeats()
        {
            string text = "  https://replay.fightcade.com/fbneo/garou/1-1 \r\n\r\nhttps://replay.fightcade.com/fbneo/mk/2-2\r\n   \r\nhttps://replay.fightcade.com/fbneo/garou/1-1\n3-3";
            Assert.Equal(new[] { "https://replay.fightcade.com/fbneo/garou/1-1", "https://replay.fightcade.com/fbneo/mk/2-2", "3-3" }, LinkList.Parse(text));
        }

        [Fact]
        public void NothingForEmptyText()
        {
            Assert.Empty(LinkList.Parse(""));
            Assert.Empty(LinkList.Parse(null));
            Assert.Empty(LinkList.Parse(" \r\n \n"));
        }
    }
}
