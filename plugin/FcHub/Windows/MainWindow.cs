using System;
using System.Linq;
using System.Numerics;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using FcHub.Allagan;
using FcHub.Game;
using FcHub.Snapshot;

namespace FcHub.Windows;

/// <summary>Probe window: shows what FC Hub can see through Allagan Tools, and how much it costs.</summary>
public sealed class MainWindow : Window
{
    private static readonly Vector4 Good = new(0.4f, 0.9f, 0.4f, 1f);
    private static readonly Vector4 Bad = new(1f, 0.45f, 0.45f, 1f);
    private static readonly Vector4 Muted = new(0.65f, 0.65f, 0.65f, 1f);

    private readonly AllaganToolsIpc allagan;
    private readonly OwnerNameTracker names;
    private readonly ProbeService probe;

    public MainWindow(AllaganToolsIpc allagan, OwnerNameTracker names, ProbeService probe)
        : base("FC Hub — probe##FcHubMain")
    {
        this.allagan = allagan;
        this.names = names;
        this.probe = probe;
        SizeConstraints = new WindowSizeConstraints
        {
            MinimumSize = new Vector2(560, 380),
            MaximumSize = new Vector2(float.MaxValue, float.MaxValue),
        };
    }

    public override void OnOpen() => probe.RequestRefresh();

    public override void Draw()
    {
        DrawStatus();
        ImGui.Separator();

        if (ImGui.Button("Refresh"))
        {
            probe.RequestRefresh();
        }

        ImGui.SameLine();
        if (ImGui.Button("Write snapshot file"))
        {
            probe.RequestRefresh(writeFile: true);
        }

        ImGui.SameLine();
        ImGui.TextColored(Muted, $"Auto-rebuilds {ProbeService.Debounce.TotalSeconds:0}s after inventory changes settle.");

        DrawLatest();
    }

    private void DrawStatus()
    {
        var loaded = allagan.IsPluginLoaded;
        var ready = loaded && allagan.IsReady();
        StatusLine("Allagan Tools loaded", loaded);
        ImGui.SameLine(0, 24);
        StatusLine("IPC ready", ready);
        ImGui.SameLine(0, 24);
        StatusLine($"Retainer list in memory ({names.RetainerCount})", names.RetainerListReady);

        var last = allagan.LastEventAt is { } at ? $"{(DateTimeOffset.UtcNow - at).TotalSeconds:0}s ago" : "never";
        ImGui.TextColored(Muted,
            $"IPC events: added {allagan.ItemAddedCount:N0} · removed {allagan.ItemRemovedCount:N0} · " +
            $"retainer changed {allagan.RetainerChangedCount} · initialized {allagan.InitializedCount} · last {last}");
    }

    private static void StatusLine(string label, bool ok)
    {
        ImGui.TextColored(ok ? Good : Bad, ok ? "●" : "○");
        ImGui.SameLine();
        ImGui.TextUnformatted(label);
    }

    private void DrawLatest()
    {
        var result = probe.Latest;
        if (result is null)
        {
            ImGui.TextUnformatted("No snapshot yet.");
            return;
        }

        if (result.Snapshot is not { } snapshot || result.Diagnostics is not { } diag)
        {
            ImGui.TextColored(Bad, result.Error ?? "Unknown error");
            return;
        }

        var age = probe.LatestAt is { } at ? (DateTimeOffset.UtcNow - at).TotalSeconds : 0;
        var totalItems = snapshot.Owners.Sum(o => o.Items.Count);
        ImGui.TextUnformatted(
            $"{snapshot.Character.Name} @ {snapshot.Character.HomeWorld ?? "?"} · {snapshot.Owners.Count} owners · " +
            $"{totalItems:N0} items ({diag.RawRows:N0} raw rows) · built {age:0}s ago");
        ImGui.TextColored(diag.CharacterIdsMatch ? Muted : Bad,
            $"Build {diag.TotalTime.TotalMilliseconds:0.0} ms (IPC {diag.IpcTime.TotalMilliseconds:0.0} ms) · " +
            $"serialize {(probe.LatestSerializeTime?.TotalMilliseconds ?? 0):0.0} ms · payload {(probe.LatestPayloadBytes ?? 0) / 1024.0:0.0} KB · " +
            $"auto rebuilds {probe.AutoRefreshCount}" +
            (diag.CharacterIdsMatch ? string.Empty : " · WARNING: Allagan current character != logged-in character"));

        if (probe.LastWrittenPath is { } path)
        {
            ImGui.TextColored(Muted, $"Last file: {path}");
        }

        if (diag.EmptyOwners.Count > 0)
        {
            ImGui.TextColored(Muted, $"Not shown (no items loaded yet): {string.Join(" | ", diag.EmptyOwners)}");
        }

        ImGui.Spacing();
        if (!ImGui.BeginTable("##owners", 5, ImGuiTableFlags.RowBg | ImGuiTableFlags.Borders | ImGuiTableFlags.Resizable))
        {
            return;
        }

        ImGui.TableSetupColumn("Kind");
        ImGui.TableSetupColumn("Name");
        ImGui.TableSetupColumn("Owner id");
        ImGui.TableSetupColumn("Items");
        ImGui.TableSetupColumn("Locations seen");
        ImGui.TableHeadersRow();

        foreach (var owner in snapshot.Owners)
        {
            ImGui.TableNextRow();
            ImGui.TableNextColumn();
            ImGui.TextUnformatted(owner.Kind.ToString());
            ImGui.TableNextColumn();
            if (owner.Name is { } ownerName)
            {
                ImGui.TextUnformatted(ownerName);
            }
            else
            {
                ImGui.TextColored(Muted, "(unknown — open the summoning bell)");
            }

            ImGui.TableNextColumn();
            ImGui.TextUnformatted(owner.OwnerId);
            ImGui.TableNextColumn();
            ImGui.TextUnformatted(owner.Items.Count.ToString("N0"));
            ImGui.TableNextColumn();
            var categories = owner.Items.Select(i => i.Category).Distinct().OrderBy(c => c);
            ImGui.TextUnformatted(string.Join(", ", categories));

            if (ImGui.IsItemHovered() && owner.Items.Count > 0)
            {
                ImGui.SetTooltip(string.Join("\n", owner.Items.Take(15).Select(i =>
                    $"{i.Quantity:N0}x {i.Name}{(i.IsHq ? " (HQ)" : string.Empty)} — {i.Location}")) +
                    (owner.Items.Count > 15 ? $"\n… and {owner.Items.Count - 15} more" : string.Empty));
            }
        }

        ImGui.EndTable();
    }
}
