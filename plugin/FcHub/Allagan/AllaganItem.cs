using FFXIVClientStructs.FFXIV.Client.Game;

namespace FcHub.Allagan;

/// <summary>
/// One inventory slot as reported by Allagan Tools IPC.
/// Mirrors the positional layout of CriticalCommonLib's <c>InventoryItem.ToNumeric()</c>:
/// <code>
///  [0] Container        [1] Slot             [2] ItemId          [3] Quantity
///  [4] Spiritbond       [5] Condition        [6] Flags           [7..11] Materia
///  [12..16] MateriaLvl  [17] Stain           [18] Stain2         [19] GlamourId
///  [20] SortedContainer [21] SortedCategory  [22] SortedSlotIndex
///  [23] RetainerId (owner) [24] RetainerMarketPrice  [25..] GearSet ids
/// </code>
/// </summary>
public readonly record struct AllaganItem(
    uint Container,
    short Slot,
    uint ItemId,
    uint Quantity,
    InventoryItem.ItemFlags Flags,
    uint SortedContainer,
    AllaganCategory SortedCategory,
    int SortedSlotIndex,
    ulong OwnerId,
    uint RetainerMarketPrice)
{
    private const int MinimumLength = 25;

    public bool IsEmpty => ItemId == 0;
    public bool IsHighQuality => (Flags & InventoryItem.ItemFlags.HighQuality) != 0;
    public bool IsCollectable => (Flags & InventoryItem.ItemFlags.Collectable) != 0;

    public static bool TryParse(ulong[]? row, out AllaganItem item)
    {
        item = default;
        if (row is null || row.Length < MinimumLength)
        {
            return false;
        }

        item = new AllaganItem(
            Container: (uint)row[0],
            Slot: (short)row[1],
            ItemId: (uint)row[2],
            Quantity: (uint)row[3],
            Flags: (InventoryItem.ItemFlags)row[6],
            SortedContainer: (uint)row[20],
            SortedCategory: (AllaganCategory)row[21],
            SortedSlotIndex: (int)row[22],
            OwnerId: row[23],
            RetainerMarketPrice: (uint)row[24]);
        return true;
    }
}

/// <summary>Copy of CriticalCommonLib's <c>InventoryCategory</c> enum (values must match).</summary>
public enum AllaganCategory
{
    Unknown = 0,
    CharacterBags = 1,
    CharacterSaddleBags = 2,
    CharacterPremiumSaddleBags = 3,
    RetainerBags = 4,
    CharacterArmoryChest = 5,
    CharacterEquipped = 6,
    RetainerEquipped = 7,
    FreeCompanyBags = 8,
    RetainerMarket = 9,
    GlamourChest = 10,
    Armoire = 11,
    Currency = 12,
    Crystals = 13,
    HousingInteriorItems = 14,
    HousingInteriorStoreroom = 15,
    HousingInteriorAppearance = 16,
    HousingExteriorItems = 17,
    HousingExteriorStoreroom = 18,
    HousingExteriorAppearance = 19,
    Other = 99,
}
