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

    /// <summary>
    /// Sections of owners the server rejected this session (key → hash, or null for a rejected
    /// removal). They aren't recorded as uploaded, so they're sent again next session or on a manual
    /// upload; until then automatic checks hold them back rather than resending them every minute.
    /// </summary>
    private readonly Dictionary<string, string?> heldBack = new();

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
        heldBack.Clear();
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

        foreach (var key in heldBack.Keys.Where(k => k.StartsWith(prefix, StringComparison.Ordinal)).ToList())
        {
            heldBack.Remove(key);
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

        // A manual upload ("Upload now") also retries owners the server rejected this session.
        var uploaded = SectionPlanner.Effective(configuration.UploadedSections, manual ? null : heldBack);
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
            Status = Status with { LastCheckAt = now, Message = WithRejections("Up to date."), IsError = false };
            return;
        }

        var accepted = plan.Outcome(result);
        foreach (var (key, hash) in accepted.Record)
        {
            configuration.UploadedSections[key] = hash;
            heldBack.Remove(key);
        }

        foreach (var key in accepted.Forget)
        {
            configuration.UploadedSections.Remove(key);
            heldBack.Remove(key);
        }

        foreach (var (key, hash) in accepted.HeldBack)
        {
            heldBack[key] = hash;
        }

        pluginInterface.SavePluginConfig(configuration);
        lastUploadAt = DateTime.UtcNow;

        var notes = new List<string>();
        if (result.SectionsSkippedStale.Count > 0) notes.Add($"{result.SectionsSkippedStale.Count} already newer on server");
        Status = new UploadStatus(
            LastCheckAt: now,
            LastSuccessAt: now,
            LastSections: result.SectionsWritten,
            LastItems: result.ItemsWritten,
            LastBytes: outcome.Response?.CompressedBytes,
            Message: WithRejections(notes.Count == 0 ? "Uploaded." : $"Uploaded ({string.Join(", ", notes)})."),
            IsError: false);
        log.Information("Uploaded {Sections} sections / {Items} items", result.SectionsWritten, result.ItemsWritten);
        if (accepted.HeldBack.Count > 0)
        {
            log.Warning("Server rejected owners {Owners}; not recorded as uploaded", string.Join(", ", result.OwnersRejected));
        }
    }

    /// <summary>Keeps unresolved rejections in the status line until they're accepted, not just on the upload that hit them.</summary>
    private string WithRejections(string message)
    {
        if (heldBack.Count == 0)
        {
            return message;
        }

        var owners = heldBack.Keys.Select(SectionPlanner.OwnerOf).Distinct(StringComparer.Ordinal).Count();
        return $"{message} The server rejected {owners} owner(s) (another member's retainer, or past the per-character owner limit); "
            + "they're sent again next session or with Upload now.";
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
