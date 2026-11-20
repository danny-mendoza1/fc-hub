namespace FcHub.Allagan;

/// <summary>
/// Allagan Tools' synthetic id for a house, apartment, or FC room, packed as
/// <c>ward &lt;&lt; 56 | plot &lt;&lt; 48 | room &lt;&lt; 32 | worldId &lt;&lt; 16 | placeNameZoneId</c>
/// (see CriticalCommonLib CharacterMonitor.InternalHouseId). Ward and plot are the game's
/// 0-based indices; plot 0x80/0x81 means an apartment building (main/subdivision).
/// </summary>
public readonly record struct AllaganHouseId(byte WardIndex, byte PlotIndex, ushort Room, ushort WorldId, ushort PlaceNameId)
{
    public static AllaganHouseId From(ulong id) => new(
        WardIndex: (byte)(id >> 56),
        PlotIndex: (byte)(id >> 48),
        Room: (ushort)(id >> 32),
        WorldId: (ushort)(id >> 16),
        PlaceNameId: (ushort)id);

    public bool IsApartment => PlotIndex >= 0x80;

    /// <summary>e.g. "Mist · Ward 2 · Plot 51" or "Mist · Ward 2 · Apartment 12 (subdivision)".</summary>
    public string Describe(string? district)
    {
        var place = string.IsNullOrEmpty(district) ? $"Zone {PlaceNameId}" : district;
        var ward = $"Ward {WardIndex + 1}";

        if (IsApartment)
        {
            var sub = PlotIndex == 0x81 ? " (subdivision)" : string.Empty;
            return $"{place} · {ward} · Apartment {Room}{sub}";
        }

        var room = Room > 0 ? $" · Room {Room}" : string.Empty;
        return $"{place} · {ward} · Plot {PlotIndex + 1}{room}";
    }
}
