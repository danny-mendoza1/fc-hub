using System;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;

namespace FcHub.Upload;

/// <summary>
/// The one way the plugin sends data to the server, shared by every upload type (inventory,
/// Wondrous Tails, and whatever comes next) so they all behave the same way:
/// one request at a time; exponential backoff after failures; a rejected key (401/403) pauses
/// every upload until the settings change; and the server's Retry-After (429 when the daily
/// write budget is spent, 503 in read-only mode) is honored.
/// Manual uploads ("Upload now", /fchub upload) skip the client-side waits; the server still
/// enforces its own limits, so that can't run up the bill.
/// All members must be used on the framework thread.
/// </summary>
public sealed class UploadChannel : IDisposable
{
    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(10);

    private readonly Configuration configuration;
    private readonly IFramework framework;
    private readonly IPluginLog log;
    private readonly CancellationTokenSource disposing = new();
    private int consecutiveFailures;
    private bool disposed;

    public UploadChannel(Configuration configuration, IFramework framework, IPluginLog log)
    {
        this.configuration = configuration;
        this.framework = framework;
        this.log = log;
    }

    public bool InFlight { get; private set; }

    /// <summary>True when the server rejected the key; cleared by <see cref="SettingsChanged"/>.</summary>
    public bool Paused { get; private set; }

    /// <summary>Automatic sends wait until this time (after a failure, or when the server said to).</summary>
    public DateTime NextAttemptAt { get; private set; } = DateTime.MinValue;

    public bool IsConfigured => HubClient.TryParseServerUrl(configuration.ServerUrl, out _, out _) && configuration.ApiKey.Length > 0;

    public void SettingsChanged()
    {
        Paused = false;
        consecutiveFailures = 0;
        NextAttemptAt = DateTime.MinValue;
    }

    /// <summary>Null when a send could start now; otherwise why not, for status lines.</summary>
    public string? Blocked(bool manual)
    {
        if (!configuration.UploadEnabled)
        {
            return "Uploads are off (enable them in settings).";
        }

        if (!IsConfigured)
        {
            return "Not configured: set the server URL and API key in settings.";
        }

        if (Paused)
        {
            return "Uploads paused: the server rejected the API key. Check it in settings.";
        }

        if (InFlight)
        {
            return "Uploading…";
        }

        if (!manual && DateTime.UtcNow < NextAttemptAt)
        {
            return $"Waiting until {NextAttemptAt.ToLocalTime():t} before trying again.";
        }

        return null;
    }

    /// <summary>
    /// Runs <paramref name="send"/> in the background unless something <see cref="Blocked"/> it, then
    /// calls <paramref name="done"/> on the framework thread. Returns false, without calling
    /// <paramref name="done"/>, when blocked.
    /// </summary>
    public bool TrySend<T>(bool manual, Func<Uri, string, CancellationToken, Task<HubResponse<T>>> send, Action<UploadOutcome<T>> done)
    {
        if (Blocked(manual) != null || !HubClient.TryParseServerUrl(configuration.ServerUrl, out var parsed, out _) || parsed is not { } server)
        {
            return false;
        }

        InFlight = true;
        var apiKey = configuration.ApiKey;
        var token = disposing.Token;
        _ = Task.Run(async () =>
        {
            HubResponse<T>? response = null;
            Exception? failure = null;
            try
            {
                response = await send(server, apiKey, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                failure = e;
            }

            await framework.RunOnFrameworkThread(() => Complete(response, failure, done)).ConfigureAwait(false);
        }, token);
        return true;
    }

    private void Complete<T>(HubResponse<T>? response, Exception? failure, Action<UploadOutcome<T>> done)
    {
        InFlight = false;
        if (disposed)
        {
            return;
        }

        if (failure == null && response is { Ok: true })
        {
            consecutiveFailures = 0;
            NextAttemptAt = DateTime.MinValue;
            done(new UploadOutcome<T>(true, response.Value, response, "Uploaded."));
            return;
        }

        var status = response?.StatusCode ?? 0;
        string message;
        if (failure != null)
        {
            log.Error(failure, "Upload failed unexpectedly");
            message = $"Error: {failure.Message}{Backoff()}";
        }
        else if (status is 401 or 403)
        {
            Paused = true;
            message = $"{response?.Error}. Uploads paused; check your API key in settings.";
        }
        else if (status is 429 or 503 && response?.RetryAfter is { } wait)
        {
            NextAttemptAt = DateTime.UtcNow + wait;
            message = $"{response!.Error} Next try at {NextAttemptAt.ToLocalTime():t}.";
        }
        else
        {
            message = $"{response?.Error ?? "Unknown error"}{Backoff()}";
        }

        log.Warning("Upload failed ({Status}): {Message}", status, message);
        done(new UploadOutcome<T>(false, default, response, message));
    }

    /// <summary>Schedules the next automatic attempt and describes the wait.</summary>
    private string Backoff()
    {
        consecutiveFailures++;
        var delay = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, MinBackoff.Ticks * (1L << Math.Min(consecutiveFailures - 1, 10))));
        NextAttemptAt = DateTime.UtcNow + delay;
        return $" Retrying in {delay.TotalSeconds:0}s.";
    }

    public void Dispose()
    {
        disposed = true;
        disposing.Cancel();
        disposing.Dispose();
    }
}

/// <param name="Ok">The server accepted the upload.</param>
/// <param name="Value">The parsed response body, when Ok.</param>
/// <param name="Message">A status line for the UI ("Uploaded.", or what went wrong and what happens next).</param>
public sealed record UploadOutcome<T>(bool Ok, T? Value, HubResponse<T>? Response, string Message);
