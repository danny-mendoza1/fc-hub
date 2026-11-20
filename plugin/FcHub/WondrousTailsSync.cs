using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Game;
using FcHub.Snapshot;
using FcHub.Upload;

namespace FcHub;

/// <summary>
/// Reads the Wondrous Tails journal of the member's chosen character about once a minute and
/// uploads it when it changes. Alts are ignored: only <see cref="Configuration.WondrousTailsContentId"/>
/// is shared (the first character seen, unless changed in settings).
/// </summary>
public sealed class WondrousTailsSync : IDisposable
{
    private static readonly TimeSpan ReadInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan DelayAfterLogin = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan RetryAfterFailure = TimeSpan.FromMinutes(5);

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly IPlayerState playerState;
    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IPluginLog log;
    private readonly Configuration configuration;
    private readonly HubClient client;
    private readonly WondrousTailsReader reader;
    private readonly string pluginVersion;
    private readonly CancellationTokenSource disposing = new();

    private DateTime nextRead = DateTime.UtcNow + DelayAfterLogin;
    private DateTime nextUploadAllowed = DateTime.MinValue;
    private bool lastReadHadNoJournal;
    private bool inFlight;
    private bool disposed;

    public WondrousTailsSync(
        IFramework framework,
        IClientState clientState,
        IPlayerState playerState,
        IDalamudPluginInterface pluginInterface,
        IPluginLog log,
        Configuration configuration,
        HubClient client,
        WondrousTailsReader reader,
        string pluginVersion)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.playerState = playerState;
        this.pluginInterface = pluginInterface;
        this.log = log;
        this.configuration = configuration;
        this.client = client;
        this.reader = reader;
        this.pluginVersion = pluginVersion;

        framework.Update += OnUpdate;
        clientState.Login += OnLogin;
    }

    /// <summary>Last journal read for the Wondrous Tails character (null when not that character or not loaded).</summary>
    public WondrousTailsState? Latest { get; private set; }
    public DateTimeOffset? LatestAt { get; private set; }
    public string Status { get; private set; } = "Waiting for the first read…";
    public bool StatusIsError { get; private set; }
    public DateTimeOffset? LastUploadAt { get; private set; }

    /// <summary>True when the logged-in character is the one sharing Wondrous Tails.</summary>
    public bool IsSharingCharacter => playerState.IsLoaded && playerState.ContentId == configuration.WondrousTailsContentId;

    public void RequestRead() => nextRead = DateTime.MinValue;

    /// <summary>Share Wondrous Tails from the logged-in character instead (settings button).</summary>
    public void UseCurrentCharacter()
    {
        if (!playerState.IsLoaded) return;
        configuration.WondrousTailsContentId = playerState.ContentId;
        configuration.WondrousTailsCharacterName = playerState.CharacterName;
        configuration.WondrousTailsUploadedHash = string.Empty;
        pluginInterface.SavePluginConfig(configuration);
        lastReadHadNoJournal = false;
        RequestRead();
    }

    private void OnLogin()
    {
        Latest = null;
        lastReadHadNoJournal = false;
        nextRead = DateTime.UtcNow + DelayAfterLogin;
    }

    private void OnUpdate(IFramework fw)
    {
        var now = DateTime.UtcNow;
        if (now < nextRead || !playerState.IsLoaded || playerState.ContentId == 0)
        {
            return;
        }

        nextRead = now + ReadInterval;

        if (configuration.WondrousTailsContentId == 0)
        {
            // First character we see becomes the Wondrous Tails character; changeable in settings.
            configuration.WondrousTailsContentId = playerState.ContentId;
            configuration.WondrousTailsCharacterName = playerState.CharacterName;
            pluginInterface.SavePluginConfig(configuration);
        }

        if (!IsSharingCharacter)
        {
            Latest = null;
            SetStatus($"Not shared from this character (sharing {configuration.WondrousTailsCharacterName}).", false);
            return;
        }

        WondrousTailsState? state;
        try
        {
            state = reader.Read();
        }
        catch (Exception e)
        {
            log.Error(e, "Reading Wondrous Tails failed");
            SetStatus($"Couldn't read the journal: {e.Message}", true);
            return;
        }

        if (state == null)
        {
            return;
        }

        Latest = state;
        LatestAt = DateTimeOffset.UtcNow;

        // Right after login the journal may not be loaded yet; only trust "no journal" if it repeats.
        if (!state.HasJournal && !lastReadHadNoJournal)
        {
            lastReadHadNoJournal = true;
            nextRead = now + TimeSpan.FromSeconds(20);
            SetStatus("No journal found; confirming…", false);
            return;
        }

        lastReadHadNoJournal = !state.HasJournal;
        Upload(state, now);
    }

    private void Upload(WondrousTailsState state, DateTime now)
    {
        if (!configuration.UploadEnabled || inFlight || now < nextUploadAllowed)
        {
            if (!configuration.UploadEnabled) SetStatus("Read OK. Uploads are off (enable them in settings).", false);
            return;
        }

        if (!HubClient.TryParseServerUrl(configuration.ServerUrl, out var server, out _) || configuration.ApiKey.Length == 0)
        {
            SetStatus("Not configured: set the server URL and API key in settings.", true);
            return;
        }

        var payload = new WondrousTailsPayload(
            WondrousTailsPayload.CurrentSchemaVersion,
            pluginVersion,
            DateTimeOffset.UtcNow,
            new SnapshotCharacter(
                playerState.ContentId.ToString(),
                playerState.CharacterName,
                playerState.HomeWorld.RowId,
                playerState.HomeWorld.ValueNullable?.Name.ExtractText()),
            state.HasJournal,
            state.IsExpired,
            state.ExpiresAt,
            state.SecondChancePoints,
            state.StickersPlaced,
            state.Slots.Select(s => new WondrousTailsSlotPayload(s.Index, s.OrderId, s.Name, s.IconId, s.Type, s.DataId, s.Status)).ToList());

        var hash = Hash(payload);
        if (hash == configuration.WondrousTailsUploadedHash)
        {
            SetStatus("Up to date.", false);
            return;
        }

        inFlight = true;
        var apiKey = configuration.ApiKey;
        var token = disposing.Token;
        _ = Task.Run(async () =>
        {
            HubResponse<WondrousTailsResult>? response = null;
            Exception? failure = null;
            try
            {
                response = await client.PostJsonAsync<WondrousTailsPayload, WondrousTailsResult>(server!, "api/v1/wondrous-tails", apiKey, payload, token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                failure = e;
            }

            await framework.RunOnFrameworkThread(() =>
            {
                inFlight = false;
                if (disposed) return;
                if (response is { Ok: true })
                {
                    configuration.WondrousTailsUploadedHash = hash;
                    pluginInterface.SavePluginConfig(configuration);
                    LastUploadAt = DateTimeOffset.UtcNow;
                    SetStatus("Uploaded.", false);
                    return;
                }

                nextUploadAllowed = DateTime.UtcNow + RetryAfterFailure;
                var message = failure?.Message ?? response?.Error ?? "Unknown error";
                log.Warning("Wondrous Tails upload failed: {Message}", message);
                SetStatus($"Upload failed: {message} (retrying in 5 min)", true);
            }).ConfigureAwait(false);
        }, token);
    }

    /// <summary>
    /// Content hash that ignores the capture time, so an unchanged journal isn't re-sent, but
    /// includes the reset week, so the first read after each weekly reset re-uploads and the
    /// website doesn't flag an unchanged book as stale.
    /// </summary>
    private static string Hash(WondrousTailsPayload payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload with { CapturedAt = default, PluginVersion = string.Empty }, UploadJson.Options);
        var week = LastWeeklyReset(DateTimeOffset.UtcNow).ToUnixTimeSeconds().ToString();
        var weekBytes = System.Text.Encoding.UTF8.GetBytes(week);
        var buffer = new byte[json.Length + weekBytes.Length];
        json.CopyTo(buffer, 0);
        weekBytes.CopyTo(buffer, json.Length);
        return Convert.ToHexString(SHA256.HashData(buffer));
    }

    /// <summary>The game's weekly reset: Tuesdays 08:00 UTC.</summary>
    public static DateTimeOffset LastWeeklyReset(DateTimeOffset now)
    {
        var utc = now.ToUniversalTime();
        var daysSinceTuesday = ((int)utc.DayOfWeek - (int)DayOfWeek.Tuesday + 7) % 7;
        var reset = new DateTimeOffset(utc.Year, utc.Month, utc.Day, 8, 0, 0, TimeSpan.Zero).AddDays(-daysSinceTuesday);
        return reset > utc ? reset.AddDays(-7) : reset;
    }

    private void SetStatus(string message, bool isError)
    {
        Status = message;
        StatusIsError = isError;
    }

    public void Dispose()
    {
        disposed = true;
        framework.Update -= OnUpdate;
        clientState.Login -= OnLogin;
        disposing.Cancel();
        disposing.Dispose();
    }
}
