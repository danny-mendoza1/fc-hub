using System;
using System.Collections.Generic;
using FcHub.Snapshot;

namespace FcHub.Upload;

// GET /api/v1/items/fc-holdings: the server's compact "places" format (PlacesWire in
// web/src/item-overlap.ts). Each section's owner and member are sent once; an item's places point
// at them by index. The contract fixture web/test/fixtures/plugin-fc-holdings-v1.json pins it.

public sealed record FcHoldingsWire(IReadOnlyList<FcHoldingsSection> Sections, IReadOnlyList<FcHoldingsItem> Items);

/// <param name="Character">The character whose upload this section came from (for a retainer, its owner).</param>
/// <param name="UpdatedAt">When the section was last captured in game.</param>
public sealed record FcHoldingsSection(
    string OwnerId,
    OwnerKind OwnerKind,
    string? OwnerName,
    string Section,
    int MemberId,
    string Member,
    string Character,
    DateTimeOffset UpdatedAt);

/// <param name="Places">Each <c>[section index, quantity, stacks]</c>.</param>
public sealed record FcHoldingsItem(uint ItemId, string Name, uint IconId, bool IsHq, IReadOnlyList<uint[]> Places);
