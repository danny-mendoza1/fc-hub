using System;
using System.Collections.Generic;

namespace FcHub.Snapshot;

// Wire format sent to the web app. 64-bit ids are strings because they exceed
// JavaScript's safe integer range. Bump SchemaVersion on breaking changes.

public sealed record InventorySnapshot(
    int SchemaVersion,
    string PluginVersion,
    DateTimeOffset CapturedAt,
    SnapshotCharacter Character,
    IReadOnlyList<SnapshotOwner> Owners)
{
    public const int CurrentSchemaVersion = 1;
}

public sealed record SnapshotCharacter(
    string ContentId,
    string Name,
    uint HomeWorldId,
    string? HomeWorld);

public sealed record SnapshotOwner(
    string OwnerId,
    OwnerKind Kind,
    string? Name,
    IReadOnlyList<SnapshotItem> Items);

public sealed record SnapshotItem(
    uint ItemId,
    string Name,
    uint IconId,
    uint Quantity,
    bool IsHq,
    bool IsCollectable,
    string Category,
    uint Container,
    uint SortedContainer,
    int SortedSlot,
    string Location);
