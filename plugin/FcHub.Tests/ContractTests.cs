using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using FcHub.Game;
using FcHub.Snapshot;
using FcHub.Tooltips;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

/// <summary>
/// The JSON the plugin sends must equal the fixtures the server's tests accept
/// (web/test/fixtures, checked in web/test/plugin-contract.test.ts). If either side changes the
/// contract, one of the two test suites fails. Compared as parsed JSON, since .NET escapes
/// non-ASCII characters ("·") that the server reads back the same either way.
/// </summary>
public class ContractTests
{
    private static readonly SnapshotCharacter Alice = new("18014498500000001", "Alice Example", 409, "Kraken");

    private static JsonNode Fixture(string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name)))!;

    private static void AssertSameJson(JsonNode expected, object payload)
    {
        var actual = JsonNode.Parse(JsonSerializer.Serialize(payload, payload.GetType(), UploadJson.Options))!;
        Assert.True(JsonNode.DeepEquals(expected, actual), $"Expected:\n{expected.ToJsonString()}\nActual:\n{actual.ToJsonString()}");
    }

    [Fact]
    public void InventoryUploadMatchesTheServersFixture()
    {
        var payload = new UploadPayload(
            UploadPayload.CurrentSchemaVersion,
            "0.2.0.0",
            new DateTimeOffset(2026, 11, 20, 18, 20, 42, TimeSpan.Zero).AddTicks(4_686_733),
            Alice,
            new[]
            {
                new UploadOwner("18014498500000001", OwnerKind.Character, "Alice Example", new[]
                {
                    new UploadSection("CharacterBags", new[] { new UploadItem(4554, "Cordial", 20603, 17, false, false, 0, 0, 1, "Inventory · bag 1 · slot 2") }),
                    new UploadSection("Currency", Array.Empty<UploadItem>()),
                }),
                new UploadOwner("9280933600000000001", OwnerKind.FreeCompany, null, new[]
                {
                    new UploadSection(
                        "FreeCompanyBags",
                        new[] { new UploadItem(80, "", 0, 2257356, false, false, 2502, 2502, 0, "FC chest · slot 1") },
                        ObservedAt: new DateTimeOffset(2026, 11, 20, 18, 15, 0, TimeSpan.Zero)),
                }),
                new UploadOwner("86131342900265472", OwnerKind.Housing, "Ishgard · Ward 2 · Plot 51", new[]
                {
                    new UploadSection("HousingInteriorItems", new[] { new UploadItem(6141, "Cordial", 20603, 1, false, false, 25003, 25003, 0, "House (interior) · page 1 · slot 1") }),
                }),
            });

        AssertSameJson(Fixture("plugin-upload-v2.json"), payload);
    }

    [Fact]
    public void WondrousTailsUploadMatchesTheServersFixture()
    {
        var slots = Enumerable.Range(0, 16)
            .Select(i => new WondrousTailsSlotPayload(
                i,
                (uint)(200 + i),
                $"Objective {i + 1}",
                (uint)(61800 + i),
                i < 8 ? 0u : (uint)(1 + i % 3),
                (uint)(1000 + i),
                i < 3 ? SlotStatus.Claimed : i == 3 ? SlotStatus.Claimable : SlotStatus.Open))
            .ToList();
        var payload = new WondrousTailsPayload(
            WondrousTailsPayload.CurrentSchemaVersion,
            "0.3.1.0",
            new DateTimeOffset(2026, 11, 20, 20, 15, 3, TimeSpan.Zero).AddTicks(1_234_567),
            Alice,
            HasJournal: true,
            IsExpired: false,
            ExpiresAt: new DateTimeOffset(2026, 12, 1, 8, 0, 0, TimeSpan.Zero),
            SecondChancePoints: 2,
            StickersPlaced: 3,
            Slots: slots);

        AssertSameJson(Fixture("plugin-wondrous-tails-v1.json"), payload);
    }

    /// <summary>The other direction: the plugin reads the response the server's test produces.</summary>
    [Fact]
    public void ReadsTheServersFcHoldingsFixture()
    {
        var json = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "plugin-fc-holdings-v1.json"));
        var wire = JsonSerializer.Deserialize<FcHoldingsWire>(json, UploadJson.Options)!;

        Assert.Equal(OwnerKind.Retainer, wire.Sections[1].OwnerKind);
        Assert.Equal(new DateTimeOffset(2026, 11, 20, 18, 20, 42, TimeSpan.Zero), wire.Sections[0].UpdatedAt);

        var holdings = FcHoldings.From(wire);
        Assert.Equal((2, 1), (holdings.ItemCount, holdings.MemberCount));
        Assert.Equal(
            "FC mates: 59\n" +
            "      Alice Example · Retainer Sir-noodle · 40\n" +
            "      Alice Example · Inventory · 17\n" +
            "      Alice Example · Inventory · 2 \uE03C",
            holdings.TextFor(4554, wire.Sections[0].UpdatedAt));
        Assert.Equal("FC mates: 900\n      Alice Example · Crystals · 900", holdings.TextFor(2, wire.Sections[0].UpdatedAt));
    }
}
