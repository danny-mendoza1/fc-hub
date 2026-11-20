using FcHub.Allagan;

namespace FcHub.Snapshot;

/// <summary>
/// Turns Allagan Tools' container/category numbers into human-readable locations,
/// e.g. "Inventory · bag 2 · slot 14" or "Retainer · page 3 · slot 12".
/// Container numbers come from FFXIVClientStructs' InventoryType plus Allagan Tools' custom values
/// (CriticalCommonLib/Enums/InventoryType.cs).
/// </summary>
public static class Locations
{
    public static string CategoryLabel(AllaganCategory category) => category switch
    {
        AllaganCategory.CharacterBags => "Inventory",
        AllaganCategory.CharacterSaddleBags => "Saddlebag",
        AllaganCategory.CharacterPremiumSaddleBags => "Premium saddlebag",
        AllaganCategory.CharacterArmoryChest => "Armoury chest",
        AllaganCategory.CharacterEquipped => "Equipped",
        AllaganCategory.Currency => "Currency",
        AllaganCategory.Crystals => "Crystals",
        AllaganCategory.RetainerBags => "Retainer",
        AllaganCategory.RetainerEquipped => "Retainer (equipped)",
        AllaganCategory.RetainerMarket => "Retainer (market)",
        AllaganCategory.FreeCompanyBags => "FC chest",
        AllaganCategory.GlamourChest => "Glamour dresser",
        AllaganCategory.Armoire => "Armoire",
        AllaganCategory.HousingInteriorItems => "House (interior)",
        AllaganCategory.HousingInteriorStoreroom => "House storeroom (interior)",
        AllaganCategory.HousingInteriorAppearance => "House fixtures (interior)",
        AllaganCategory.HousingExteriorItems => "House (exterior)",
        AllaganCategory.HousingExteriorStoreroom => "House storeroom (exterior)",
        AllaganCategory.HousingExteriorAppearance => "House fixtures (exterior)",
        _ => "Other",
    };

    /// <summary>Which kind of owner a category implies.</summary>
    public static OwnerKind KindOf(AllaganCategory category) => category switch
    {
        AllaganCategory.RetainerBags or AllaganCategory.RetainerEquipped or AllaganCategory.RetainerMarket
            => OwnerKind.Retainer,
        AllaganCategory.FreeCompanyBags => OwnerKind.FreeCompany,
        AllaganCategory.HousingInteriorItems or AllaganCategory.HousingInteriorStoreroom or
        AllaganCategory.HousingInteriorAppearance or AllaganCategory.HousingExteriorItems or
        AllaganCategory.HousingExteriorStoreroom or AllaganCategory.HousingExteriorAppearance
            => OwnerKind.Housing,
        AllaganCategory.Unknown or AllaganCategory.Other => OwnerKind.Unknown,
        _ => OwnerKind.Character,
    };

    /// <summary>1-based page/bag number within the category, or null when pages don't apply.</summary>
    public static int? PageOf(uint container) => container switch
    {
        <= 3 => (int)container + 1,                                // Inventory1-4
        >= 4000 and <= 4001 => (int)(container - 4000) + 1,         // SaddleBag1-2
        >= 4100 and <= 4101 => (int)(container - 4100) + 1,         // PremiumSaddleBag1-2
        >= 10000 and <= 10006 => (int)(container - 10000) + 1,      // RetainerPage1-7
        >= 20000 and <= 20010 => (int)(container - 20000) + 1,      // FreeCompanyPage1-11
        >= 25003 and <= 25014 => (int)(container - 25003) + 1,      // HousingInteriorPlacedItems
        >= 27001 and <= 27011 => (int)(container - 27001) + 1,      // HousingInteriorStoreroom
        _ => null,
    };

    /// <summary>Armoury chest sub-section names.</summary>
    public static string? ArmourySection(uint container) => container switch
    {
        3200 => "off hand",
        3201 => "head",
        3202 => "body",
        3203 => "hands",
        3204 => "waist",
        3205 => "legs",
        3206 => "feet",
        3207 => "earrings",
        3208 => "necklace",
        3209 => "bracelets",
        3300 => "rings",
        3400 => "soul crystals",
        3500 => "main hand",
        _ => null,
    };

    public static string Describe(in AllaganItem item)
    {
        var label = CategoryLabel(item.SortedCategory);
        var slot = item.SortedSlotIndex + 1;

        if (item.SortedCategory == AllaganCategory.CharacterArmoryChest && ArmourySection(item.SortedContainer) is { } section)
        {
            return $"{label} · {section} · slot {slot}";
        }

        if (PageOf(item.SortedContainer) is { } page)
        {
            var pageWord = item.SortedCategory == AllaganCategory.CharacterBags ? "bag" : "page";
            return $"{label} · {pageWord} {page} · slot {slot}";
        }

        return item.SortedCategory is AllaganCategory.Armoire or AllaganCategory.GlamourChest or
               AllaganCategory.Currency or AllaganCategory.Crystals
            ? label
            : $"{label} · slot {slot}";
    }
}

public enum OwnerKind
{
    Unknown,
    Character,
    Retainer,
    FreeCompany,
    Housing,
}
