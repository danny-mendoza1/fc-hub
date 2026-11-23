using System;
using Dalamud.Plugin.Services;
using FcHub.Tooltips;
using FcHub.Upload;

namespace FcHub;

/// <summary>
/// Downloads the other members' holdings for item tooltips: shortly after login, then every few
/// minutes, and on /fchub upload. Hovering only reads the in-memory index, never the network.
/// Goes through the shared <see cref="UploadChannel"/>, so a rejected key, backoff and the server's
/// Retry-After apply here too, and like every send it needs uploads on: you see your mates' items
/// when you share yours (ADR 0009).
/// </summary>
public sealed class FcHoldingsSync : IDisposable
{
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan DelayAfterLogin = TimeSpan.FromSeconds(15);

    private readonly IFramework framework;
    private readonly IClientState clientState;
    private readonly Configuration configuration;
    private readonly HubClient client;
    private readonly UploadChannel channel;

    private DateTime nextFetch = DateTime.UtcNow + DelayAfterLogin;
    private bool manualRequested;

    public FcHoldingsSync(IFramework framework, IClientState clientState, Configuration configuration, HubClient client, UploadChannel channel)
    {
        this.framework = framework;
        this.clientState = clientState;
        this.configuration = configuration;
        this.client = client;
        this.channel = channel;

        framework.Update += OnUpdate;
        clientState.Login += OnLogin;
    }

    /// <summary>The latest download; empty until the first one lands. Replaced whole, on the framework thread.</summary>
    public FcHoldings Holdings { get; private set; } = FcHoldings.Empty;

    public DateTimeOffset? UpdatedAt { get; private set; }
    public string Status { get; private set; } = "Waiting for the first download…";
    public bool StatusIsError { get; private set; }

    /// <summary>The tooltip lines for an item (null when turned off or no mate holds it).</summary>
    public string? TooltipText(HoveredItem item) =>
        configuration.ShowFcMatesInTooltips ? Holdings.TextFor(item.ItemId, DateTimeOffset.UtcNow) : null;

    /// <summary>Download now, skipping the usual waits (/fchub upload, settings saved).</summary>
    public void RequestRefresh()
    {
        nextFetch = DateTime.MinValue;
        manualRequested = true;
    }

    private void OnLogin() => nextFetch = DateTime.UtcNow + DelayAfterLogin;

    private void OnUpdate(IFramework fw)
    {
        var now = DateTime.UtcNow;
        if (now < nextFetch || !clientState.IsLoggedIn)
        {
            return;
        }

        nextFetch = now + RefreshInterval;
        var manual = manualRequested;
        manualRequested = false;

        if (!configuration.ShowFcMatesInTooltips)
        {
            SetStatus("Off (turn it on in settings).", false);
            return;
        }

        var blocked = channel.Blocked(manual);
        if (blocked != null)
        {
            if (channel.InFlight)
            {
                // An upload is using the channel; try again shortly (still manual if it was).
                nextFetch = now + UploadChannel.BusyRetryDelay;
                manualRequested |= manual;
                return;
            }

            SetStatus(configuration.UploadEnabled ? blocked : "Off while uploads are off: you see your mates' items when you share yours.", configuration.UploadEnabled);
            return;
        }

        channel.TrySend<FcHoldingsWire>(
            manual,
            client.GetFcHoldingsAsync,
            outcome =>
            {
                if (!outcome.Ok || outcome.Value is not { } wire)
                {
                    SetStatus($"Download failed: {outcome.Message}", true);
                    return;
                }

                Holdings = FcHoldings.From(wire);
                UpdatedAt = DateTimeOffset.UtcNow;
                SetStatus($"{Holdings.ItemCount:N0} items from {Holdings.MemberCount} mate{(Holdings.MemberCount == 1 ? "" : "s")}.", false);
            });
    }

    private void SetStatus(string message, bool isError)
    {
        Status = message;
        StatusIsError = isError;
    }

    public void Dispose()
    {
        framework.Update -= OnUpdate;
        clientState.Login -= OnLogin;
    }
}
