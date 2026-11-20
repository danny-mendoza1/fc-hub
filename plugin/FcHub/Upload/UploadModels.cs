using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using FcHub.Snapshot;

namespace FcHub.Upload;

// Upload contract v2 (see web/README.md and web/src/contract.ts). Keep the two in sync.

public sealed record UploadPayload(
    int SchemaVersion,
    string PluginVersion,
    DateTimeOffset CapturedAt,
    SnapshotCharacter Character,
    IReadOnlyList<UploadOwner> Owners)
{
    public const int CurrentSchemaVersion = 2;
}

public sealed record UploadOwner(string OwnerId, OwnerKind Kind, string? Name, IReadOnlyList<UploadSection> Sections);

public sealed record UploadSection(string Section, IReadOnlyList<UploadItem> Items);

public sealed record UploadItem(
    uint ItemId,
    string Name,
    uint IconId,
    uint Quantity,
    bool IsHq,
    bool IsCollectable,
    uint Container,
    uint SortedContainer,
    int SortedSlot,
    string Location);

/// <summary>Server response to POST /api/v1/snapshots.</summary>
public sealed record UploadResult(
    int SectionsWritten,
    int ItemsWritten,
    IReadOnlyList<string> SectionsSkippedStale,
    IReadOnlyList<string> OwnersRejected);

/// <summary>Server response to GET /api/v1/me.</summary>
public sealed record MeResponse(MeMember Member, IReadOnlyList<MeCharacter> Characters);

public sealed record MeMember(int Id, string DisplayName);

public sealed record MeCharacter(string ContentId, string Name, string? HomeWorld, string LastUploadAt);

public static class UploadJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}
