using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using FcHub.Allagan;
using FcHub.Snapshot;

namespace FcHub;

/// <summary>
/// Phase-1 probe: builds snapshots from Allagan Tools on demand and automatically a few seconds
/// after inventory changes settle, and measures how expensive that is. This logic becomes the
/// upload pipeline once the web API exists.
/// </summary>
public sealed class ProbeService : IDisposable
{
    /// <summary>Wait this long after the last inventory change before rebuilding.</summary>
    public static readonly TimeSpan Debounce = TimeSpan.FromSeconds(5);

    private readonly IFramework framework;
    private readonly IChatGui chat;
    private readonly IPluginLog log;
    private readonly AllaganToolsIpc allagan;
    private readonly SnapshotBuilder builder;
    private readonly DirectoryInfo outputDirectory;

    private bool refreshRequested;
    private bool writeRequested;
    private DateTime? dirtySince;

    public ProbeService(
        IFramework framework,
        IChatGui chat,
        IPluginLog log,
        AllaganToolsIpc allagan,
        SnapshotBuilder builder,
        DirectoryInfo outputDirectory)
    {
        this.framework = framework;
        this.chat = chat;
        this.log = log;
        this.allagan = allagan;
        this.builder = builder;
        this.outputDirectory = outputDirectory;

        allagan.Changed += OnAllaganChanged;
        framework.Update += OnUpdate;
    }

    public SnapshotResult? Latest { get; private set; }
    public DateTimeOffset? LatestAt { get; private set; }
    public long? LatestPayloadBytes { get; private set; }
    public TimeSpan? LatestSerializeTime { get; private set; }
    public int AutoRefreshCount { get; private set; }
    public string? LastWrittenPath { get; private set; }

    /// <summary>Queue a rebuild on the next framework tick (safe to call from UI code).</summary>
    public void RequestRefresh(bool writeFile = false)
    {
        refreshRequested = true;
        writeRequested |= writeFile;
    }

    private void OnAllaganChanged() => dirtySince = DateTime.UtcNow;

    private void OnUpdate(IFramework fw)
    {
        var auto = dirtySince is { } since && DateTime.UtcNow - since >= Debounce;
        if (!refreshRequested && !auto)
        {
            return;
        }

        var write = writeRequested;
        refreshRequested = false;
        writeRequested = false;
        dirtySince = null;
        if (auto)
        {
            AutoRefreshCount++;
        }

        SnapshotResult result;
        try
        {
            result = builder.Build();
        }
        catch (Exception e)
        {
            log.Error(e, "Snapshot build failed");
            result = SnapshotResult.Fail($"Exception: {e.Message}");
        }

        Latest = result;
        LatestAt = DateTimeOffset.UtcNow;

        if (result.Snapshot is not { } snapshot)
        {
            if (write)
            {
                chat.PrintError($"[FC Hub] {result.Error}");
            }

            return;
        }

        // Serialization and file IO happen off the framework thread so the game never waits on them.
        _ = Task.Run(async () =>
        {
            try
            {
                var stopwatch = Stopwatch.StartNew();
                var json = SnapshotJson.Serialize(snapshot);
                stopwatch.Stop();
                var bytes = Encoding.UTF8.GetByteCount(json);

                string? path = null;
                if (write)
                {
                    var written = await SnapshotJson.WriteAsync(snapshot, outputDirectory).ConfigureAwait(false);
                    path = written.Path;
                }

                await framework.RunOnFrameworkThread(() =>
                {
                    LatestPayloadBytes = bytes;
                    LatestSerializeTime = stopwatch.Elapsed;
                    if (path != null)
                    {
                        LastWrittenPath = path;
                        chat.Print($"[FC Hub] Wrote snapshot ({bytes / 1024.0:F1} KB) to {path}");
                    }
                }).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                log.Error(e, "Snapshot serialization/write failed");
            }
        });
    }

    public void Dispose()
    {
        allagan.Changed -= OnAllaganChanged;
        framework.Update -= OnUpdate;
    }
}
