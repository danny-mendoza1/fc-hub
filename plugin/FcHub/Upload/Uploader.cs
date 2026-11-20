using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Snapshot;

namespace FcHub.Upload;

/// <summary>
/// Uploads changed sections in the background. One upload at a time; failures back off
/// exponentially; auth failures pause uploading until the settings change.
/// All public members must be used on the framework thread.
/// </summary>
public sealed class Uploader : IDisposable
{
    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(10);

    private readonly Configuration configuration;
    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IFramework framework;
    private readonly IPluginLog log;
    private readonly HubClient client;
    private readonly string pluginVersion;
    private readonly CancellationTokenSource disposing = new();

    private bool inFlight;
    private bool disposed;
    private int consecutiveFailures;
    private DateTime nextAttemptAt = DateTime.MinValue;

    public Uploader(Configuration configuration, IDalamudPluginInterface pluginInterface, IFramework framework, IPluginLog log, HubClient client, string pluginVersion)
    {
        this.configuration = configuration;
        this.pluginInterface = pluginInterface;
        this.framework = framework;
        this.log = log;
        this.client = client;
        this.pluginVersion = pluginVersion;
    }

    public UploadStatus Status { get; private set; } = UploadStatus.Initial;

    /// <summary>True when auth failed; cleared by <see cref="SettingsChanged"/>.</summary>
    public bool Paused { get; private set; }

    public bool IsConfigured => HubClient.TryParseServerUrl(configuration.ServerUrl, out _, out _) && configuration.ApiKey.Length > 0;

    public void SettingsChanged()
    {
        Paused = false;
        consecutiveFailures = 0;
        nextAttemptAt = DateTime.MinValue;
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
        nextAttemptAt = DateTime.MinValue;
    }

    /// <summary>Offer a freshly built snapshot; uploads whatever changed unless busy, paused or backing off.</summary>
    public void Offer(InventorySnapshot snapshot, bool force = false)
    {
        if (!configuration.UploadEnabled || Paused || inFlight)
        {
            return;
        }

        if (!HubClient.TryParseServerUrl(configuration.ServerUrl, out var server, out _) || configuration.ApiKey.Length == 0)
        {
            Status = Status with { Message = "Not configured: set the server URL and API key in settings." };
            return;
        }

        if (!force && DateTime.UtcNow < nextAttemptAt)
        {
            return;
        }

        inFlight = true;
        var apiKey = configuration.ApiKey;
        var uploaded = new Dictionary<string, string>(configuration.UploadedSections);
        var token = disposing.Token;

        _ = Task.Run(async () =>
        {
            UploadPlan? plan = null;
            HubResponse<UploadResult>? response = null;
            Exception? failure = null;
            try
            {
                plan = SectionPlanner.Plan(snapshot, uploaded, pluginVersion);
                if (!plan.IsEmpty)
                {
                    response = await client.UploadAsync(server!, apiKey, plan.Payload, token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                failure = e;
            }

            await framework.RunOnFrameworkThread(() => Complete(plan, response, failure)).ConfigureAwait(false);
        }, token);
    }

    private void Complete(UploadPlan? plan, HubResponse<UploadResult>? response, Exception? failure)
    {
        inFlight = false;
        if (disposed)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow;
        if (failure != null)
        {
            log.Error(failure, "Upload failed unexpectedly");
            Fail(now, $"Error: {failure.Message}");
            return;
        }

        if (plan == null)
        {
            Fail(now, "Error: no upload plan.");
            return;
        }

        if (plan.IsEmpty)
        {
            consecutiveFailures = 0;
            Status = Status with { LastCheckAt = now, Message = "Up to date." };
            return;
        }

        if (response is { Ok: true, Value: { } result })
        {
            foreach (var (key, hash) in plan.NewHashes)
            {
                configuration.UploadedSections[key] = hash;
            }

            foreach (var key in plan.RemovedKeys)
            {
                configuration.UploadedSections.Remove(key);
            }

            pluginInterface.SavePluginConfig(configuration);
            consecutiveFailures = 0;
            nextAttemptAt = DateTime.MinValue;

            var notes = new List<string>();
            if (result.SectionsSkippedStale.Count > 0) notes.Add($"{result.SectionsSkippedStale.Count} already newer on server");
            if (result.OwnersRejected.Count > 0) notes.Add($"{result.OwnersRejected.Count} owner(s) rejected");
            Status = new UploadStatus(
                LastCheckAt: now,
                LastSuccessAt: now,
                LastSections: result.SectionsWritten,
                LastItems: result.ItemsWritten,
                LastBytes: response.CompressedBytes,
                Message: notes.Count == 0 ? "Uploaded." : $"Uploaded ({string.Join(", ", notes)}).",
                IsError: false);
            log.Information("Uploaded {Sections} sections / {Items} items", result.SectionsWritten, result.ItemsWritten);
            return;
        }

        var status = response?.StatusCode ?? 0;
        var message = response?.Error ?? "Unknown error";
        if (status is 401 or 403)
        {
            Paused = true;
            Status = Status with { LastCheckAt = now, Message = $"{message}. Uploads paused; check your API key in settings.", IsError = true };
            log.Warning("Upload rejected ({Status}): {Message}", status, message);
            return;
        }

        log.Warning("Upload failed ({Status}): {Message}", status, message);
        Fail(now, message);
    }

    private void Fail(DateTimeOffset now, string message)
    {
        consecutiveFailures++;
        var delay = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, MinBackoff.Ticks * (1L << Math.Min(consecutiveFailures - 1, 10))));
        nextAttemptAt = DateTime.UtcNow + delay;
        Status = Status with { LastCheckAt = now, Message = $"{message} Retrying in {delay.TotalSeconds:0}s.", IsError = true };
    }

    public void Dispose()
    {
        disposed = true;
        disposing.Cancel();
        disposing.Dispose();
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
