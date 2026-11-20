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
    }

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
        var rawRows = 0;
        foreach (var ownerId in orderedOwners)
        {
            var raw = allagan.GetItems(ownerId);
            rawRows += raw.Count;
            var items = raw.Where(i => !i.IsEmpty).Select(ToSnapshotItem).ToList();
            var kind = ownerId == contentId ? OwnerKind.Character : InferKind(raw);
            owners.Add(new SnapshotOwner(ownerId.ToString(), kind, names.NameOf(ownerId), items));
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
            IpcTime: ipcElapsed,
            TotalTime: stopwatch.Elapsed));
    }

    private static OwnerKind InferKind(IReadOnlyList<AllaganItem> items)
    {
        // An owner's kind isn't exposed over IPC; infer it from where its items live.
        foreach (var item in items)
        {
            var kind = Locations.KindOf(item.SortedCategory);
            if (kind != OwnerKind.Unknown)
            {
                return kind;
            }
        }

        return OwnerKind.Unknown;
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
            return (row.Name.ExtractText(), row.Icon);
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
    TimeSpan IpcTime,
    TimeSpan TotalTime);

public sealed record SnapshotResult(InventorySnapshot? Snapshot, SnapshotDiagnostics? Diagnostics, string? Error)
{
    public static SnapshotResult Ok(InventorySnapshot snapshot, SnapshotDiagnostics diagnostics) => new(snapshot, diagnostics, null);
    public static SnapshotResult Fail(string error) => new(null, null, error);
}
