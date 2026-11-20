using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using FcHub.Allagan;
using FcHub.Snapshot;
using FcHub.Upload;

namespace FcHub;

/// <summary>
/// Decides when to rebuild the snapshot and hands it to the uploader:
/// a few seconds after Allagan Tools reports changes, every minute as a safety net (moves within
/// a container don't raise IPC events), and on demand. A rebuild costs ~2 ms on the framework thread;
/// hashing, serialization and network IO happen on background threads.
/// </summary>
public sealed class SyncService : IDisposable
{
    /// <summary>Wait this long after the last inventory change before rebuilding.</summary>
    public static readonly TimeSpan Debounce = TimeSpan.FromSeconds(5);

    /// <summary>Rebuild at least this often to catch changes that raise no IPC event.</summary>
    public static readonly TimeSpan PeriodicInterval = TimeSpan.FromSeconds(60);

    private readonly IFramework framework;
    private readonly IChatGui chat;
    private readonly IPluginLog log;
    private readonly AllaganToolsIpc allagan;
    private readonly SnapshotBuilder builder;
    private readonly Uploader uploader;
    private readonly DirectoryInfo outputDirectory;

    private bool refreshRequested;
    private bool writeRequested;
    private bool forceUpload;
    private DateTime? dirtySince;
    private DateTime nextPeriodic = DateTime.UtcNow + TimeSpan.FromSeconds(10);

    public SyncService(
        IFramework framework,
        IChatGui chat,
        IPluginLog log,
        AllaganToolsIpc allagan,
        SnapshotBuilder builder,
        Uploader uploader,
        DirectoryInfo outputDirectory)
    {
        this.framework = framework;
        this.chat = chat;
        this.log = log;
        this.allagan = allagan;
        this.builder = builder;
        this.uploader = uploader;
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
    public void RequestRefresh(bool writeFile = false, bool upload = false)
    {
        refreshRequested = true;
        writeRequested |= writeFile;
        forceUpload |= upload;
    }

    private void OnAllaganChanged() => dirtySince = DateTime.UtcNow;

    private void OnUpdate(IFramework fw)
    {
        var now = DateTime.UtcNow;
        var changed = dirtySince is { } since && now - since >= Debounce;
        var periodic = now >= nextPeriodic;
        if (!refreshRequested && !changed && !periodic)
        {
            return;
        }

        var write = writeRequested;
        var force = forceUpload;
        refreshRequested = false;
        writeRequested = false;
        forceUpload = false;
        dirtySince = null;
        nextPeriodic = now + PeriodicInterval;
        if (changed || periodic)
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

        uploader.Offer(snapshot, force);

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
