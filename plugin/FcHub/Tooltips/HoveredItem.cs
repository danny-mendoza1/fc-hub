namespace FcHub.Tooltips;

/// <summary>
/// The item under the cursor, decoded from Dalamud's <c>IGameGui.HoveredItem</c>. The game folds
/// the quality into the id: +1,000,000 for HQ and +500,000 for collectables; ids of 2,000,000 and
/// up are key/event items, which nobody stores in FC Hub.
/// </summary>
public readonly record struct HoveredItem(uint ItemId, bool IsHq, bool IsCollectable)
{
    private const ulong HqOffset = 1_000_000;
    private const ulong CollectableOffset = 500_000;
    private const ulong EventItemStart = 2_000_000;

    public static HoveredItem? FromHoveredId(ulong hoveredId)
    {
        if (hoveredId == 0 || hoveredId >= EventItemStart)
        {
            return null;
        }

        var isHq = hoveredId >= HqOffset;
        var isCollectable = !isHq && hoveredId >= CollectableOffset;
        var itemId = (uint)(hoveredId % CollectableOffset);
        return itemId == 0 ? null : new HoveredItem(itemId, isHq, isCollectable);
    }
}
