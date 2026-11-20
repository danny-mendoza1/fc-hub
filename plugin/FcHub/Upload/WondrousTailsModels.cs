using System;
using System.Collections.Generic;
using FcHub.Game;
using FcHub.Snapshot;

namespace FcHub.Upload;

// Wondrous Tails upload contract v1 (see web/src/wondrous-tails.ts). Keep the two in sync.

public sealed record WondrousTailsPayload(
    int SchemaVersion,
    string PluginVersion,
    DateTimeOffset CapturedAt,
    SnapshotCharacter Character,
    bool HasJournal,
    bool IsExpired,
    DateTimeOffset? ExpiresAt,
    uint SecondChancePoints,
    int StickersPlaced,
    IReadOnlyList<WondrousTailsSlotPayload> Slots)
{
    public const int CurrentSchemaVersion = 1;
}

public sealed record WondrousTailsSlotPayload(int Index, uint OrderId, string Name, uint IconId, uint Type, uint DataId, SlotStatus Status);

/// <summary>Server response to POST /api/v1/wondrous-tails.</summary>
public sealed record WondrousTailsResult(string Status, bool TurnedInInferred);
