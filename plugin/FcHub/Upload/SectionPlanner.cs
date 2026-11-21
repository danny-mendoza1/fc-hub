using System;
using System.Collections.Generic;
using System.Linq;
using FcHub.Snapshot;

namespace FcHub.Upload;

/// <summary>
/// Decides which sections need uploading by hashing each (owner, section) and comparing it with
/// the hash the server last accepted. Pure function of its inputs; safe to run off the framework thread.
/// </summary>
public static class SectionPlanner
{
    public static string Key(string contentId, string ownerId, string section) => $"{contentId}/{ownerId}/{section}";

    /// <summary>The owner id in a <see cref="Key"/> (ids are decimal, so they never contain '/').</summary>
    public static string OwnerOf(string key) => key.Split('/', 3)[1];

    /// <summary>
    /// What a plan should treat as already uploaded: the hashes the server accepted, plus the
    /// sections it rejected this session (<paramref name="heldBack"/>; see <see cref="UploadPlan.Outcome"/>),
    /// so automatic checks don't resend a rejected owner every minute. Pass null to retry them.
    /// </summary>
    public static Dictionary<string, string> Effective(IReadOnlyDictionary<string, string> uploaded, IReadOnlyDictionary<string, string?>? heldBack)
    {
        var effective = new Dictionary<string, string>(uploaded);
        foreach (var (key, hash) in heldBack ?? new Dictionary<string, string?>())
        {
            if (hash is null)
            {
                // A rejected removal: leave it out so the planner doesn't send the empty section again.
                effective.Remove(key);
            }
            else
            {
                effective[key] = hash;
            }
        }

        return effective;
    }

    /// <param name="sightings">
    /// When shared sections were last seen in game (<see cref="ObservationTracker"/>); shared sections
    /// whose contents match a sighting carry its time as <see cref="UploadSection.ObservedAt"/>.
    /// </param>
    public static UploadPlan Plan(
        InventorySnapshot snapshot,
        IReadOnlyDictionary<string, string> uploaded,
        string pluginVersion,
        IReadOnlyDictionary<string, SectionObservation>? sightings = null)
    {
        var contentId = snapshot.Character.ContentId;
        var owners = new List<UploadOwner>();
        var newHashes = new Dictionary<string, string>();
        var removedKeys = new List<string>();
        var itemCount = 0;

        foreach (var owner in snapshot.Owners)
        {
            var sections = new List<UploadSection>();
            var present = new HashSet<string>();

            foreach (var group in owner.Items.GroupBy(i => i.Category))
            {
                present.Add(group.Key);
                var items = group.Select(ToUploadItem).ToList();
                // Owner name/kind are part of the hash so a newly learned retainer name gets uploaded.
                var hash = Hash(owner.Kind, owner.Name, items);
                var key = Key(contentId, owner.OwnerId, group.Key);
                if (uploaded.TryGetValue(key, out var previous) && previous == hash)
                {
                    continue;
                }

                sections.Add(new UploadSection(group.Key, items, SeenAt(sightings, owner, group.Key, items)));
                newHashes[key] = hash;
                itemCount += items.Count;
            }

            // Sections we uploaded before but that are gone now (e.g. all market listings sold):
            // send them empty so the server clears them.
            var prefix = Key(contentId, owner.OwnerId, string.Empty);
            foreach (var key in uploaded.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)))
            {
                var section = key[prefix.Length..];
                if (!present.Contains(section))
                {
                    sections.Add(new UploadSection(section, Array.Empty<UploadItem>(), SeenAt(sightings, owner, section, Array.Empty<UploadItem>())));
                    removedKeys.Add(key);
                }
            }

            if (sections.Count > 0)
            {
                owners.Add(new UploadOwner(owner.OwnerId, owner.Kind, owner.Name, sections));
            }
        }

        var payload = new UploadPayload(UploadPayload.CurrentSchemaVersion, pluginVersion, snapshot.CapturedAt, snapshot.Character, owners);
        return new UploadPlan(payload, newHashes, removedKeys, owners.Sum(o => o.Sections.Count), itemCount);
    }

    private static DateTimeOffset? SeenAt(
        IReadOnlyDictionary<string, SectionObservation>? sightings, SnapshotOwner owner, string section, IReadOnlyList<UploadItem> items) =>
        sightings != null && ObservationTracker.IsShared(owner.Kind) ? ObservationTracker.SeenAt(sightings, owner.OwnerId, section, items) : null;

    /// <summary>An item as it travels in an upload (and as section contents are hashed).</summary>
    public static UploadItem ToUploadItem(SnapshotItem i) => new(
        i.ItemId, i.Name, i.IconId, i.Quantity, i.IsHq, i.IsCollectable, i.Container, i.SortedContainer, i.SortedSlot, i.Location);

    private static string Hash(OwnerKind kind, string? name, IReadOnlyList<UploadItem> items) =>
        ContentHash.Of(items, prefix: $"{kind}\u0000{name}\u0000");
}

/// <param name="NewHashes">Hashes to record once the server accepts the upload (see <see cref="UploadPlan.Outcome"/>).</param>
/// <param name="RemovedKeys">Section keys to forget once the server accepts the upload (see <see cref="UploadPlan.Outcome"/>).</param>
public sealed record UploadPlan(
    UploadPayload Payload,
    IReadOnlyDictionary<string, string> NewHashes,
    IReadOnlyList<string> RemovedKeys,
    int SectionCount,
    int ItemCount)
{
    public bool IsEmpty => SectionCount == 0;

    /// <summary>
    /// Splits the plan by the server's answer. Sections of rejected owners weren't stored, so their
    /// hashes must not be recorded, or they'd never be sent again (e.g. after an admin raises the
    /// per-character owner limit). Everything else was stored, or skipped because the server already
    /// holds newer data, which won't change by resending, so it's recorded.
    /// </summary>
    public PlanOutcome Outcome(UploadResult result)
    {
        var rejected = new HashSet<string>(result.OwnersRejected ?? Array.Empty<string>(), StringComparer.Ordinal);
        var record = new Dictionary<string, string>();
        var forget = new List<string>();
        var heldBack = new Dictionary<string, string?>();
        foreach (var (key, hash) in NewHashes)
        {
            if (rejected.Contains(SectionPlanner.OwnerOf(key)))
            {
                heldBack[key] = hash;
            }
            else
            {
                record[key] = hash;
            }
        }

        foreach (var key in RemovedKeys)
        {
            if (rejected.Contains(SectionPlanner.OwnerOf(key)))
            {
                heldBack[key] = null;
            }
            else
            {
                forget.Add(key);
            }
        }

        return new PlanOutcome(record, forget, heldBack);
    }
}

/// <param name="Record">Section hashes the server accepted (or already had newer data for).</param>
/// <param name="Forget">Removed sections the server cleared.</param>
/// <param name="HeldBack">Sections of owners the server rejected: their hash, or null for a removal. Not recorded.</param>
public sealed record PlanOutcome(
    IReadOnlyDictionary<string, string> Record,
    IReadOnlyList<string> Forget,
    IReadOnlyDictionary<string, string?> HeldBack);
