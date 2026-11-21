using System;
using System.Collections.Generic;
using System.Linq;
using FcHub.Snapshot;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

/// <summary>
/// Shared sections say when they were last seen in game, not when the snapshot was built (ADR 0008):
/// the review's case is a fresh install or "Re-upload everything" stamping an old cached FC chest as new.
/// </summary>
public class ObservationTrackerTests
{
    private const string Alice = "18014498500000001";
    private const string AliceAlt = "18014498500000009";
    private const string Fc = "9280933600000000001";
    private const string Retainer = "33777097200000001";

    private static readonly DateTimeOffset Monday = new(2026, 11, 16, 20, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Tuesday = new(2026, 11, 17, 20, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Friday = new(2026, 11, 20, 20, 0, 0, TimeSpan.Zero);

    private static SnapshotItem Item(uint itemId, uint quantity, string category) =>
        new(itemId, $"Item {itemId}", 1000 + itemId, quantity, false, false, category, 0, 0, 0, "slot 1");

    private static SnapshotOwner Chest(uint credits, string? name = null) =>
        new(Fc, OwnerKind.FreeCompany, name, new[] { Item(80, credits, "FreeCompanyBags") });

    private static InventorySnapshot Snapshot(DateTimeOffset at, params SnapshotOwner[] owners) => Snapshot(Alice, at, owners);

    private static InventorySnapshot Snapshot(string contentId, DateTimeOffset at, params SnapshotOwner[] owners) =>
        new(InventorySnapshot.CurrentSchemaVersion, "test", at, new SnapshotCharacter(contentId, "Alice", 409, "Kraken"), owners);

    /// <summary>What a fresh install or "Re-upload everything" sends: every section, nothing recorded as uploaded.</summary>
    private static DateTimeOffset? SentObservedAt(InventorySnapshot snapshot, IReadOnlyDictionary<string, SectionObservation> sightings, string section = "FreeCompanyBags") =>
        SectionPlanner.Plan(snapshot, new Dictionary<string, string>(), "test", sightings)
            .Payload.Owners.Single(o => o.OwnerId == Fc).Sections.Single(s => s.Section == section).ObservedAt;

    [Fact]
    public void ContentsFirstSeenThisSessionAreNotASighting()
    {
        // Allagan Tools' cache at login could be days old.
        var sightings = new Dictionary<string, SectionObservation>();
        var tracker = new ObservationTracker(sightings);

        Assert.False(tracker.Observe(Snapshot(Friday, Chest(100))));
        Assert.Null(SentObservedAt(Snapshot(Friday, Chest(100)), tracker.Copy()));
    }

    [Fact]
    public void AChangeWhileWatchingIsASightingAtThatSnapshotsTime()
    {
        var tracker = new ObservationTracker(new Dictionary<string, SectionObservation>());
        tracker.Observe(Snapshot(Monday, Chest(100)));

        Assert.True(tracker.Observe(Snapshot(Tuesday, Chest(250))));
        Assert.Equal(Tuesday, SentObservedAt(Snapshot(Tuesday, Chest(250)), tracker.Copy()));
    }

    [Fact]
    public void AReuploadOfCachedContentsCarriesTheirSightingNotTheSnapshotTime()
    {
        // Regression (review, finding 4): the chest was last seen on Tuesday; "Re-upload everything" on
        // Friday used to send it stamped Friday, outranking a mate who looked on Thursday.
        var sightings = new Dictionary<string, SectionObservation>();
        var tuesdaySession = new ObservationTracker(sightings);
        tuesdaySession.Observe(Snapshot(Monday, Chest(100)));
        tuesdaySession.Observe(Snapshot(Tuesday, Chest(250)));

        var fridaySession = new ObservationTracker(sightings); // the plugin restarted; sightings persist
        fridaySession.Observe(Snapshot(Friday, Chest(250)));

        var plan = SectionPlanner.Plan(Snapshot(Friday, Chest(250)), new Dictionary<string, string>(), "test", fridaySession.Copy());
        Assert.Equal(Friday, plan.Payload.CapturedAt);
        Assert.Equal(Tuesday, plan.Payload.Owners.Single(o => o.OwnerId == Fc).Sections.Single().ObservedAt);
    }

    [Fact]
    public void ContentsThatChangedWhileNotWatchingHaveNoSighting()
    {
        // Seen on Tuesday; by Friday Allagan Tools holds something else (FC Hub was off when it changed).
        var sightings = new Dictionary<string, SectionObservation>();
        var tracker = new ObservationTracker(sightings);
        tracker.Observe(Snapshot(Monday, Chest(100)));
        tracker.Observe(Snapshot(Tuesday, Chest(250)));

        var later = new ObservationTracker(sightings);
        Assert.False(later.Observe(Snapshot(Friday, Chest(400))));
        Assert.Null(SentObservedAt(Snapshot(Friday, Chest(400)), later.Copy()));
    }

    [Fact]
    public void AltsShareTheFcChestsSighting()
    {
        // The review's alt case: an alt in the same FC re-sends the chest from Allagan Tools' shared data.
        var tracker = new ObservationTracker(new Dictionary<string, SectionObservation>());
        tracker.Observe(Snapshot(Monday, Chest(100)));
        tracker.Observe(Snapshot(Tuesday, Chest(250)));

        Assert.Equal(Tuesday, SentObservedAt(Snapshot(AliceAlt, Friday, Chest(250)), tracker.Copy()));
    }

    [Fact]
    public void LearningTheFcsNameIsNotASighting()
    {
        var tracker = new ObservationTracker(new Dictionary<string, SectionObservation>());
        tracker.Observe(Snapshot(Monday, Chest(100)));
        Assert.False(tracker.Observe(Snapshot(Tuesday, Chest(100, name: "Free Company"))));
    }

    [Fact]
    public void ASectionEmptiedWhileWatchingIsASightingOfAnEmptySection()
    {
        var tracker = new ObservationTracker(new Dictionary<string, SectionObservation>());
        var house = (params SnapshotItem[] items) => new SnapshotOwner(Fc, OwnerKind.FreeCompany, null, items);
        tracker.Observe(Snapshot(Monday, house(Item(80, 100, "FreeCompanyBags"), Item(81, 1, "FreeCompanyCrystals"))));
        Assert.True(tracker.Observe(Snapshot(Tuesday, house(Item(80, 100, "FreeCompanyBags")))));

        // The planner sends the vanished section empty; it carries the sighting of its emptying.
        var uploaded = new Dictionary<string, string> { [SectionPlanner.Key(Alice, Fc, "FreeCompanyCrystals")] = "earlier" };
        var plan = SectionPlanner.Plan(Snapshot(Tuesday, house(Item(80, 100, "FreeCompanyBags"))), uploaded, "test", tracker.Copy());
        var emptied = plan.Payload.Owners.Single().Sections.Single(s => s.Section == "FreeCompanyCrystals");
        Assert.Empty(emptied.Items);
        Assert.Equal(Tuesday, emptied.ObservedAt);
    }

    [Fact]
    public void PrivateOwnersNeverCarryASighting()
    {
        // Retainers and the character have one reporter, so report time is enough.
        var tracker = new ObservationTracker(new Dictionary<string, SectionObservation>());
        var retainer = (uint n) => new SnapshotOwner(Retainer, OwnerKind.Retainer, "Bobbin", new[] { Item(2, n, "RetainerBags") });
        tracker.Observe(Snapshot(Monday, retainer(1)));
        Assert.False(tracker.Observe(Snapshot(Tuesday, retainer(2))));

        var plan = SectionPlanner.Plan(Snapshot(Tuesday, retainer(2)), new Dictionary<string, string>(), "test", tracker.Copy());
        Assert.All(plan.Payload.Owners.SelectMany(o => o.Sections), s => Assert.Null(s.ObservedAt));
    }
}
