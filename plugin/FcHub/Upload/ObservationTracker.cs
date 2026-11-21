using System;
using System.Collections.Generic;
using System.Linq;
using FcHub.Snapshot;

namespace FcHub.Upload;

/// <summary>
/// When a shared section (FC chest, house storage) was last seen in game, as opposed to merely
/// read from Allagan Tools' cache (ADR 0008).
/// <para>
/// Allagan Tools keeps every container's contents between sessions and reports them as current, so
/// a snapshot's time says nothing about when the FC chest was last looked at: a fresh install,
/// "Re-upload everything", an alt or a retry can send days-old contents stamped "now", and replace
/// a mate's newer look on the server. What does show a sighting is the contents changing while
/// FC Hub is watching, since Allagan Tools only learns new contents when the game sends them (the
/// chest or storeroom is open). Each such change is recorded with its time and a hash of what was
/// seen, per owner and section (not per character: alts share Allagan Tools' FC and house data),
/// and kept across sessions. A section whose contents still match its last sighting carries that
/// time; any other (seen for the first time this session, or changed while FC Hub wasn't watching)
/// carries none, and the server ranks it below every sighting.
/// </para>
/// Use <see cref="Observe"/> on the framework thread; the static members are pure.
/// </summary>
public sealed class ObservationTracker
{
    private static readonly string EmptyHash = HashOf(Array.Empty<UploadItem>());

    private readonly IDictionary<string, SectionObservation> sightings;

    /// <summary>Each shared section's content hash in the previous snapshot this session.</summary>
    private readonly Dictionary<string, string> previous = new(StringComparer.Ordinal);

    /// <param name="sightings">Persisted sightings (the plugin config's), updated in place.</param>
    public ObservationTracker(IDictionary<string, SectionObservation> sightings)
    {
        this.sightings = sightings;
    }

    /// <summary>Owners several members report, and so can disagree about.</summary>
    public static bool IsShared(OwnerKind kind) => kind is OwnerKind.FreeCompany or OwnerKind.Housing;

    public static string Key(string ownerId, string section) => $"{ownerId}/{section}";

    /// <summary>Contents only (no owner name), so learning an owner's name isn't taken for a sighting.</summary>
    public static string HashOf(IReadOnlyList<UploadItem> items) => ContentHash.Of(items);

    /// <summary>When these exact contents were last seen in game, if they were.</summary>
    public static DateTimeOffset? SeenAt(
        IReadOnlyDictionary<string, SectionObservation> sightings, string ownerId, string section, IReadOnlyList<UploadItem> items) =>
        sightings.TryGetValue(Key(ownerId, section), out var seen) && seen.Hash == HashOf(items) ? seen.At : null;

    /// <summary>
    /// Compares a snapshot with the previous one. Every shared section whose contents changed in
    /// between was seen at <see cref="InventorySnapshot.CapturedAt"/>. Returns true when a sighting
    /// was recorded (so the caller saves the config).
    /// </summary>
    public bool Observe(InventorySnapshot snapshot)
    {
        var recorded = false;
        foreach (var owner in snapshot.Owners.Where(o => IsShared(o.Kind)))
        {
            var current = owner.Items
                .GroupBy(i => i.Category, StringComparer.Ordinal)
                .ToDictionary(g => Key(owner.OwnerId, g.Key), g => HashOf(g.Select(SectionPlanner.ToUploadItem).ToList()), StringComparer.Ordinal);

            // A section seen earlier this session that's gone now was emptied in front of us.
            var prefix = Key(owner.OwnerId, string.Empty);
            foreach (var key in previous.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)))
            {
                current.TryAdd(key, EmptyHash);
            }

            foreach (var (key, hash) in current)
            {
                if (previous.TryGetValue(key, out var before) && before != hash)
                {
                    sightings[key] = new SectionObservation { Hash = hash, At = snapshot.CapturedAt };
                    recorded = true;
                }

                previous[key] = hash;
            }
        }

        return recorded;
    }

    /// <summary>A copy of the sightings, for planning off the framework thread.</summary>
    public IReadOnlyDictionary<string, SectionObservation> Copy() => new Dictionary<string, SectionObservation>(sightings, StringComparer.Ordinal);
}

/// <summary>A shared section's contents (hash) as last seen in game, and when.</summary>
[Serializable]
public sealed class SectionObservation
{
    public string Hash { get; set; } = string.Empty;
    public DateTimeOffset At { get; set; }
}
