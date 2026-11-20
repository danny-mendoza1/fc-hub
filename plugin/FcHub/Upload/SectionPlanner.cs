using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FcHub.Snapshot;

namespace FcHub.Upload;

/// <summary>
/// Decides which sections need uploading by hashing each (owner, section) and comparing it with
/// the hash the server last accepted. Pure function of its inputs; safe to run off the framework thread.
/// </summary>
public static class SectionPlanner
{
    public static string Key(string contentId, string ownerId, string section) => $"{contentId}/{ownerId}/{section}";

    public static UploadPlan Plan(InventorySnapshot snapshot, IReadOnlyDictionary<string, string> uploaded, string pluginVersion)
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

                sections.Add(new UploadSection(group.Key, items));
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
                    sections.Add(new UploadSection(section, Array.Empty<UploadItem>()));
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

    private static UploadItem ToUploadItem(SnapshotItem i) => new(
        i.ItemId, i.Name, i.IconId, i.Quantity, i.IsHq, i.IsCollectable, i.Container, i.SortedContainer, i.SortedSlot, i.Location);

    private static string Hash(OwnerKind kind, string? name, IReadOnlyList<UploadItem> items)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(items, UploadJson.Options);
        var header = Encoding.UTF8.GetBytes($"{kind}\u0000{name}\u0000");
        var buffer = new byte[header.Length + json.Length];
        header.CopyTo(buffer, 0);
        json.CopyTo(buffer, header.Length);
        return Convert.ToHexString(SHA256.HashData(buffer));
    }
}

/// <param name="NewHashes">Hashes to record once the server accepts the upload.</param>
/// <param name="RemovedKeys">Section keys to forget once the server accepts the upload.</param>
public sealed record UploadPlan(
    UploadPayload Payload,
    IReadOnlyDictionary<string, string> NewHashes,
    IReadOnlyList<string> RemovedKeys,
    int SectionCount,
    int ItemCount)
{
    public bool IsEmpty => SectionCount == 0;
}
