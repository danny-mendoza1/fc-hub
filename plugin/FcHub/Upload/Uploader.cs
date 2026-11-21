using System;
using System.Collections.Generic;
using System.Linq;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Snapshot;

namespace FcHub.Upload;

/// <summary>
/// Uploads changed inventory sections through the shared <see cref="UploadChannel"/>.
/// Automatic uploads happen at most once per <see cref="MinAutomaticInterval"/>: changes in
/// between wait for the next check and go up together, which keeps the server's write cost down
/// during crafting or gathering. Manual uploads ("Upload now", /fchub upload) go straight away.
/// All public members must be used on the framework thread.
/// </summary>
public sealed class Uploader
{
    /// <summary>Minimum time between automatic uploads.</summary>
    public static readonly TimeSpan MinAutomaticInterval = TimeSpan.FromSeconds(60);

    private readonly Configuration configuration;
    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IPluginLog log;
    private readonly HubClient client;
    private readonly UploadChannel channel;
    private readonly string pluginVersion;
    private DateTime lastUploadAt = DateTime.MinValue;

    public Uploader(Configuration configuration, IDalamudPluginInterface pluginInterface, IPluginLog log, HubClient client, UploadChannel channel, string pluginVersion)
    {
        this.configuration = configuration;
        this.pluginInterface = pluginInterface;
        this.log = log;
        this.client = client;
        this.channel = channel;
        this.pluginVersion = pluginVersion;
    }

    public UploadStatus Status { get; private set; } = UploadStatus.Initial;

    /// <summary>True when the server rejected the key; cleared by <see cref="SettingsChanged"/>.</summary>
    public bool Paused => channel.Paused;

    public bool IsConfigured => channel.IsConfigured;

    public void SettingsChanged()
    {
        channel.SettingsChanged();
        lastUploadAt = DateTime.MinValue;
        Status = Status with { Message = IsConfigured ? "Settings saved; uploading on next check." : "Not configured." };
    }

    /// <summary>Forget what was uploaded for a character so everything is sent again.</summary>
    public void ResetCharacter(string contentId)
    {
        var prefix = contentId + "/";
        foreach (var key in configuration.UploadedSections.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).ToList())
        {
            configuration.UploadedSections.Remove(key);
        }

        pluginInterface.SavePluginConfig(configuration);
    }

    /// <summary>
    /// Offer a freshly built snapshot; uploads whatever changed unless busy, paused, backing off, or
    /// (for automatic uploads) within a minute of the last upload. <paramref name="manual"/> skips the waits.
    /// </summary>
    public void Offer(InventorySnapshot snapshot, bool manual = false)
    {
        if (!manual && DateTime.UtcNow - lastUploadAt < MinAutomaticInterval)
        {
            return;
        }

        var blocked = channel.Blocked(manual);
        if (blocked != null)
        {
            if (!channel.InFlight)
            {
                Status = Status with { Message = blocked };
            }

            return;
        }

        var uploaded = new Dictionary<string, string>(configuration.UploadedSections);
        UploadPlan? plan = null;
        channel.TrySend<UploadResult>(
            manual,
            async (server, apiKey, token) =>
            {
                // Hashing and serializing happen here, off the framework thread.
                plan = SectionPlanner.Plan(snapshot, uploaded, pluginVersion);
                if (plan.IsEmpty)
                {
                    return new HubResponse<UploadResult>(true, 0, null, null, null);
                }

                return await client.UploadAsync(server, apiKey, plan.Payload, token).ConfigureAwait(false);
            },
            outcome => Complete(plan, outcome));
    }

    private void Complete(UploadPlan? plan, UploadOutcome<UploadResult> outcome)
    {
        var now = DateTimeOffset.UtcNow;
        if (!outcome.Ok)
        {
            Status = Status with { LastCheckAt = now, Message = outcome.Message, IsError = true };
            return;
        }

        if (plan == null || plan.IsEmpty || outcome.Value is not { } result)
        {
            Status = Status with { LastCheckAt = now, Message = "Up to date.", IsError = false };
            return;
        }

        foreach (var (key, hash) in plan.NewHashes)
        {
            configuration.UploadedSections[key] = hash;
        }

        foreach (var key in plan.RemovedKeys)
        {
            configuration.UploadedSections.Remove(key);
        }

        pluginInterface.SavePluginConfig(configuration);
        lastUploadAt = DateTime.UtcNow;

        var notes = new List<string>();
        if (result.SectionsSkippedStale.Count > 0) notes.Add($"{result.SectionsSkippedStale.Count} already newer on server");
        if (result.OwnersRejected.Count > 0) notes.Add($"{result.OwnersRejected.Count} owner(s) rejected");
        Status = new UploadStatus(
            LastCheckAt: now,
            LastSuccessAt: now,
            LastSections: result.SectionsWritten,
            LastItems: result.ItemsWritten,
            LastBytes: outcome.Response?.CompressedBytes,
            Message: notes.Count == 0 ? "Uploaded." : $"Uploaded ({string.Join(", ", notes)}).",
            IsError: false);
        log.Information("Uploaded {Sections} sections / {Items} items", result.SectionsWritten, result.ItemsWritten);
    }
}

public sealed record UploadStatus(
    DateTimeOffset? LastCheckAt,
    DateTimeOffset? LastSuccessAt,
    int LastSections,
    int LastItems,
    long? LastBytes,
    string Message,
    bool IsError)
{
    public static readonly UploadStatus Initial = new(null, null, 0, 0, null, "Not uploaded yet.", false);
}
