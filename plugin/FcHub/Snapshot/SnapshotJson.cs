using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace FcHub.Snapshot;

/// <summary>Serializes snapshots exactly as they'll be uploaded, and writes them to disk for inspection.</summary>
public static class SnapshotJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string Serialize(InventorySnapshot snapshot) => JsonSerializer.Serialize(snapshot, Options);

    /// <summary>Writes the snapshot off the framework thread; returns the file path and size in bytes.</summary>
    public static async Task<(string Path, long Bytes)> WriteAsync(InventorySnapshot snapshot, DirectoryInfo directory)
    {
        directory.Create();
        var path = Path.Combine(directory.FullName, $"snapshot-{snapshot.Character.ContentId}.json");
        var json = Serialize(snapshot);
        await File.WriteAllTextAsync(path, json).ConfigureAwait(false);
        return (path, new FileInfo(path).Length);
    }
}
