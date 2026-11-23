using FcHub.Tooltips;
using Xunit;

namespace FcHub.Tests;

public class HoveredItemTests
{
    [Theory]
    [InlineData(5057UL, 5057U, false, false)] // NQ
    [InlineData(1_005_057UL, 5057U, true, false)] // HQ
    [InlineData(505_057UL, 5057U, false, true)] // collectable
    public void DecodesQualityFromTheHoveredId(ulong hoveredId, uint itemId, bool isHq, bool isCollectable)
    {
        Assert.Equal(new HoveredItem(itemId, isHq, isCollectable), HoveredItem.FromHoveredId(hoveredId));
    }

    [Theory]
    [InlineData(0UL)] // nothing hovered
    [InlineData(2_000_001UL)] // key/event item
    [InlineData(500_000UL)] // offset with no item
    [InlineData(1_000_000UL)]
    public void IgnoresIdsThatAreNotStorableItems(ulong hoveredId)
    {
        Assert.Null(HoveredItem.FromHoveredId(hoveredId));
    }
}
