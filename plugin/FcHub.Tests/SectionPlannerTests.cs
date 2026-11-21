using System;
using System.Collections.Generic;
using System.Linq;
using FcHub.Snapshot;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

public class SectionPlannerTests
{
    private const string Alice = "18014498500000001";
    private static readonly SnapshotCharacter Character = new(Alice, "Alice Example", 409, "Kraken");

    private static SnapshotItem Item(uint itemId, uint quantity, string category = "CharacterBags", int slot = 0) =>
        new(itemId, $"Item {itemId}", 1000 + itemId, quantity, false, false, category, 0, 0, slot, $"slot {slot + 1}");

    private static InventorySnapshot Snapshot(string? ownerName, params SnapshotItem[] items) =>
        new(InventorySnapshot.CurrentSchemaVersion, "test", DateTimeOffset.UnixEpoch, Character,
            new[] { new SnapshotOwner(Alice, OwnerKind.Character, ownerName, items) });

    /// <summary>What the uploader records once the server accepts a plan.</summary>
    private static Dictionary<string, string> Accept(UploadPlan plan, Dictionary<string, string>? uploaded = null)
    {
        var next = new Dictionary<string, string>(uploaded ?? new Dictionary<string, string>());
        foreach (var (key, hash) in plan.NewHashes) next[key] = hash;
        foreach (var key in plan.RemovedKeys) next.Remove(key);
        return next;
    }

    private static string[] SentSections(UploadPlan plan) =>
        plan.Payload.Owners.SelectMany(o => o.Sections).Select(s => s.Section).OrderBy(s => s, StringComparer.Ordinal).ToArray();

    [Fact]
    public void TheFirstPlanSendsEverySection()
    {
        var plan = SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5), Item(2, 1, "Crystals")), new Dictionary<string, string>(), "test");
        Assert.Equal(new[] { "CharacterBags", "Crystals" }, SentSections(plan));
        Assert.Equal(2, plan.ItemCount);
        Assert.Equal(2, plan.NewHashes.Count);
    }

    [Fact]
    public void AnUnchangedSnapshotSendsNothing()
    {
        var snapshot = Snapshot("Alice Example", Item(1, 5), Item(2, 1, "Crystals"));
        var uploaded = Accept(SectionPlanner.Plan(snapshot, new Dictionary<string, string>(), "test"));
        Assert.True(SectionPlanner.Plan(snapshot, uploaded, "test").IsEmpty);
    }

    [Fact]
    public void OnlyTheChangedSectionIsSent()
    {
        var uploaded = Accept(SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5), Item(2, 1, "Crystals")), new Dictionary<string, string>(), "test"));
        var plan = SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 6), Item(2, 1, "Crystals")), uploaded, "test");
        Assert.Equal(new[] { "CharacterBags" }, SentSections(plan));
    }

    [Fact]
    public void AVanishedSectionIsSentEmptySoTheServerClearsIt()
    {
        var uploaded = Accept(SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5), Item(2, 1, "RetainerMarket")), new Dictionary<string, string>(), "test"));
        var plan = SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5)), uploaded, "test");

        var section = Assert.Single(plan.Payload.Owners.SelectMany(o => o.Sections));
        Assert.Equal("RetainerMarket", section.Section);
        Assert.Empty(section.Items);
        Assert.Equal(new[] { SectionPlanner.Key(Alice, Alice, "RetainerMarket") }, plan.RemovedKeys);
        Assert.True(SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5)), Accept(plan, uploaded), "test").IsEmpty);
    }

    [Fact]
    public void ANewlyLearnedOwnerNameIsSent()
    {
        var uploaded = Accept(SectionPlanner.Plan(Snapshot(null, Item(1, 5)), new Dictionary<string, string>(), "test"));
        var plan = SectionPlanner.Plan(Snapshot("Alice Example", Item(1, 5)), uploaded, "test");
        Assert.Equal("Alice Example", Assert.Single(plan.Payload.Owners).Name);
    }
}
