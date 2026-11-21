using System;
using System.Collections.Generic;
using System.Linq;
using FcHub.Snapshot;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

/// <summary>
/// What the uploader records after the server answers (Uploader.Complete wires these together):
/// rejected owners must stay unrecorded so they're sent again, without resending them every minute.
/// </summary>
public class UploadOutcomeTests
{
    private const string Alice = "18014498500000001";
    private const string Retainer = "33777097200000001";
    private const string Fc = "9280933600000000001";
    private static readonly SnapshotCharacter Character = new(Alice, "Alice Example", 409, "Kraken");

    private static SnapshotItem Item(uint itemId, string category) =>
        new(itemId, $"Item {itemId}", 1000 + itemId, 1, false, false, category, 0, 0, 0, "slot 1");

    private static InventorySnapshot Snapshot(params SnapshotOwner[] owners) =>
        new(InventorySnapshot.CurrentSchemaVersion, "test", DateTimeOffset.UnixEpoch, Character, owners);

    private static readonly SnapshotOwner Self = new(Alice, OwnerKind.Character, "Alice Example", new[] { Item(1, "CharacterBags") });
    private static readonly SnapshotOwner Bobbin = new(Retainer, OwnerKind.Retainer, "Bobbin", new[] { Item(2, "RetainerBags") });
    private static readonly SnapshotOwner Chest = new(Fc, OwnerKind.FreeCompany, null, new[] { Item(3, "FreeCompanyBags") });

    private static UploadResult Result(IEnumerable<string>? stale = null, IEnumerable<string>? rejected = null) =>
        new(0, 0, (stale ?? Array.Empty<string>()).ToList(), (rejected ?? Array.Empty<string>()).ToList());

    /// <summary>The config after Uploader.Complete applies an outcome.</summary>
    private static Dictionary<string, string> Apply(Dictionary<string, string> uploaded, PlanOutcome outcome)
    {
        var next = new Dictionary<string, string>(uploaded);
        foreach (var (key, hash) in outcome.Record) next[key] = hash;
        foreach (var key in outcome.Forget) next.Remove(key);
        return next;
    }

    private static string[] SentOwners(UploadPlan plan) => plan.Payload.Owners.Select(o => o.OwnerId).ToArray();

    [Fact]
    public void OwnerOfReadsTheOwnerFromASectionKey()
    {
        Assert.Equal(Retainer, SectionPlanner.OwnerOf(SectionPlanner.Key(Alice, Retainer, "RetainerBags")));
    }

    [Fact]
    public void ARejectedOwnerIsNotRecordedAsUploaded()
    {
        var plan = SectionPlanner.Plan(Snapshot(Self, Bobbin), new Dictionary<string, string>(), "test");
        var outcome = plan.Outcome(Result(rejected: new[] { Retainer }));

        Assert.Equal(new[] { SectionPlanner.Key(Alice, Alice, "CharacterBags") }, outcome.Record.Keys.ToArray());
        Assert.Equal(new[] { SectionPlanner.Key(Alice, Retainer, "RetainerBags") }, outcome.HeldBack.Keys.ToArray());
    }

    [Fact]
    public void ARejectedOwnerIsSentAgainNextSessionOrOnAManualUpload()
    {
        // Regression: the plugin used to record every planned hash, so a rejected retainer (say, past the
        // per-character owner limit) was never sent again, even after the limit was raised.
        var snapshot = Snapshot(Self, Bobbin);
        var first = SectionPlanner.Plan(snapshot, new Dictionary<string, string>(), "test");
        var outcome = first.Outcome(Result(rejected: new[] { Retainer }));
        var uploaded = Apply(new Dictionary<string, string>(), outcome);

        var retry = SectionPlanner.Plan(snapshot, SectionPlanner.Effective(uploaded, heldBack: null), "test");
        Assert.Equal(new[] { Retainer }, SentOwners(retry));
    }

    [Fact]
    public void AutomaticChecksHoldARejectedOwnerBackUntilItChanges()
    {
        var snapshot = Snapshot(Self, Bobbin);
        var outcome = SectionPlanner.Plan(snapshot, new Dictionary<string, string>(), "test").Outcome(Result(rejected: new[] { Retainer }));
        var uploaded = Apply(new Dictionary<string, string>(), outcome);

        Assert.True(SectionPlanner.Plan(snapshot, SectionPlanner.Effective(uploaded, outcome.HeldBack), "test").IsEmpty);

        var changed = Snapshot(Self, Bobbin with { Items = new[] { Item(2, "RetainerBags"), Item(4, "RetainerBags") } });
        Assert.Equal(new[] { Retainer }, SentOwners(SectionPlanner.Plan(changed, SectionPlanner.Effective(uploaded, outcome.HeldBack), "test")));
    }

    [Fact]
    public void ARejectedRemovalIsNeitherForgottenNorResentAutomatically()
    {
        var selling = Snapshot(Self, Bobbin with { Items = new[] { Item(2, "RetainerBags"), Item(5, "RetainerMarket") } });
        var uploaded = Apply(new Dictionary<string, string>(), SectionPlanner.Plan(selling, new Dictionary<string, string>(), "test").Outcome(Result()));

        // Everything on the market sold, so the plan sends that section empty; the server rejects the owner.
        var emptied = Snapshot(Self, Bobbin);
        var plan = SectionPlanner.Plan(emptied, uploaded, "test");
        var key = SectionPlanner.Key(Alice, Retainer, "RetainerMarket");
        Assert.Contains(key, plan.RemovedKeys);
        var outcome = plan.Outcome(Result(rejected: new[] { Retainer }));

        Assert.Empty(outcome.Forget);
        Assert.Null(outcome.HeldBack[key]);
        var after = Apply(uploaded, outcome);
        Assert.True(after.ContainsKey(key), "still recorded, so a later plan retries the removal");
        Assert.True(SectionPlanner.Plan(emptied, SectionPlanner.Effective(after, outcome.HeldBack), "test").IsEmpty);
        Assert.Equal(new[] { Retainer }, SentOwners(SectionPlanner.Plan(emptied, SectionPlanner.Effective(after, heldBack: null), "test")));
    }

    [Fact]
    public void ASectionTheServerAlreadyHasNewerDataForIsRecorded()
    {
        // Stale skips are final (resending the same data can't win), so they must not be retried.
        var snapshot = Snapshot(Self, Chest);
        var plan = SectionPlanner.Plan(snapshot, new Dictionary<string, string>(), "test");
        var outcome = plan.Outcome(Result(stale: new[] { $"{Fc}/FreeCompanyBags" }));

        Assert.Empty(outcome.HeldBack);
        Assert.True(SectionPlanner.Plan(snapshot, Apply(new Dictionary<string, string>(), outcome), "test").IsEmpty);
    }
}
