using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Dalamud.Plugin.Services;
using FcHub.Allagan;
using FcHub.Game;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace FcHub.Snapshot;

/// <summary>
/// Builds an <see cref="InventorySnapshot"/> for the logged-in character from Allagan Tools IPC.
/// Must run on the framework thread.
/// </summary>
public sealed class SnapshotBuilder
{
    private readonly AllaganToolsIpc allagan;
    private readonly OwnerNameTracker names;
    private readonly IPlayerState playerState;
    private readonly ExcelSheet<Item> itemSheet;
    private readonly ExcelSheet<EventItem> eventItemSheet;
    private readonly ExcelSheet<PlaceName> placeNameSheet;
    private readonly string pluginVersion;

    public SnapshotBuilder(
        AllaganToolsIpc allagan,
        OwnerNameTracker names,
        IPlayerState playerState,
        IDataManager dataManager,
        string pluginVersion)
    {
        this.allagan = allagan;
        this.names = names;
        this.playerState = playerState;
        this.pluginVersion = pluginVersion;
        itemSheet = dataManager.GetExcelSheet<Item>();
        eventItemSheet = dataManager.GetExcelSheet<EventItem>();
        placeNameSheet = dataManager.GetExcelSheet<PlaceName>();
    }

    /// <summary>Items whose Item-sheet name is blank but that Allagan Tools still reports.</summary>
    private static readonly Dictionary<uint, string> FallbackItemNames = new()
    {
        [80] = "Company Credits",
    };

    public SnapshotResult Build()
    {
        if (!playerState.IsLoaded || playerState.ContentId == 0)
        {
            return SnapshotResult.Fail("Not logged in.");
        }

        if (!allagan.IsPluginLoaded)
        {
            return SnapshotResult.Fail("Allagan Tools is not installed or not loaded.");
        }

        if (!allagan.IsReady())
        {
            return SnapshotResult.Fail("Allagan Tools is loaded but its IPC is not ready yet.");
        }

        var stopwatch = Stopwatch.StartNew();
        var contentId = playerState.ContentId;
        var allaganCharacter = allagan.GetCurrentCharacter();

        var ownerIds = allagan.GetOwnedByActive(includeOwner: false);
        var orderedOwners = new List<ulong> { contentId };
        orderedOwners.AddRange(ownerIds.Where(id => id != contentId).OrderBy(id => id));

        var owners = new List<SnapshotOwner>(orderedOwners.Count);
        var emptyOwners = new List<string>();
        var rawRows = 0;
        foreach (var ownerId in orderedOwners)
        {
            var raw = allagan.GetItems(ownerId);
            rawRows += raw.Count;
            var kind = ResolveKind(ownerId, contentId, raw);
            var name = names.NameOf(ownerId) ?? (kind == OwnerKind.Housing ? DescribeHouse(ownerId) : null);
            var items = raw.Where(i => !i.IsEmpty).Select(ToSnapshotItem).ToList();

            // Nothing to search; usually a house whose storage hasn't been loaded yet.
            if (items.Count == 0)
            {
                emptyOwners.Add($"{kind}: {name ?? ownerId.ToString()}");
                continue;
            }

            owners.Add(new SnapshotOwner(ownerId.ToString(), kind, name, items));
        }

        var ipcElapsed = stopwatch.Elapsed;

        var homeWorld = playerState.HomeWorld;
        var snapshot = new InventorySnapshot(
            InventorySnapshot.CurrentSchemaVersion,
            pluginVersion,
            DateTimeOffset.UtcNow,
            new SnapshotCharacter(
                contentId.ToString(),
                playerState.CharacterName,
                homeWorld.RowId,
                homeWorld.ValueNullable?.Name.ExtractText()),
            owners);

        stopwatch.Stop();
        return SnapshotResult.Ok(snapshot, new SnapshotDiagnostics(
            AllaganCurrentCharacter: allaganCharacter,
            CharacterIdsMatch: allaganCharacter == contentId,
            RawRows: rawRows,
            EmptyOwners: emptyOwners,
            IpcTime: ipcElapsed,
            TotalTime: stopwatch.Elapsed));
    }

    /// <summary>
    /// An owner's kind isn't exposed over IPC. Use, in order: the logged-in character, where its
    /// items live, what we've learned from game memory, and finally elimination. Besides the
    /// character, Allagan Tools only reports retainers, the FC chest, and housing; we learn
    /// retainer and FC ids ourselves, so anything left over is housing.
    /// </summary>
    private OwnerKind ResolveKind(ulong ownerId, ulong contentId, IReadOnlyList<AllaganItem> items)
    {
        if (ownerId == contentId)
        {
            return OwnerKind.Character;
        }

        foreach (var item in items)
        {
            var fromItems = Locations.KindOf(item.SortedCategory);
            if (fromItems != OwnerKind.Unknown)
            {
                return fromItems;
            }
        }

        return names.KindOf(ownerId) ?? OwnerKind.Housing;
    }

    private string DescribeHouse(ulong ownerId)
    {
        var house = AllaganHouseId.From(ownerId);
        var district = placeNameSheet.GetRowOrDefault(house.PlaceNameId)?.Name.ExtractText();
        return house.Describe(district);
    }

    private SnapshotItem ToSnapshotItem(AllaganItem item)
    {
        var (name, icon) = LookupItem(item.ItemId);
        return new SnapshotItem(
            item.ItemId,
            name,
            icon,
            item.Quantity,
            item.IsHighQuality,
            item.IsCollectable,
            item.SortedCategory.ToString(),
            item.Container,
            item.SortedContainer,
            item.SortedSlotIndex,
            Locations.Describe(item));
    }

    private (string Name, uint Icon) LookupItem(uint itemId)
    {
        if (itemSheet.GetRowOrDefault(itemId) is { } row)
        {
            var name = row.Name.ExtractText();
            if (name.Length == 0)
            {
                name = FallbackItemNames.GetValueOrDefault(itemId, $"Unknown item #{itemId}");
            }

            return (name, row.Icon);
        }

        if (eventItemSheet.GetRowOrDefault(itemId) is { } eventRow)
        {
            return (eventRow.Name.ExtractText(), eventRow.Icon);
        }

        return ($"Unknown item #{itemId}", 0);
    }
}

public sealed record SnapshotDiagnostics(
    ulong AllaganCurrentCharacter,
    bool CharacterIdsMatch,
    int RawRows,
    IReadOnlyList<string> EmptyOwners,
    TimeSpan IpcTime,
    TimeSpan TotalTime);

public sealed record SnapshotResult(InventorySnapshot? Snapshot, SnapshotDiagnostics? Diagnostics, string? Error)
{
    public static SnapshotResult Ok(InventorySnapshot snapshot, SnapshotDiagnostics diagnostics) => new(snapshot, diagnostics, null);
    public static SnapshotResult Fail(string error) => new(null, null, error);
}
