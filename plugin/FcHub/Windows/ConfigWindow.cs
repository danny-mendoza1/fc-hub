using System;
using System.Linq;
using System.Numerics;
using System.Threading;
using System.Threading.Tasks;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Upload;

namespace FcHub.Windows;

/// <summary>Server URL, API key and upload toggle. Opened from /xlplugins (cog) or /fchub config.</summary>
public sealed class ConfigWindow : Window, IDisposable
{
    private static readonly Vector4 Good = new(0.4f, 0.9f, 0.4f, 1f);
    private static readonly Vector4 Bad = new(1f, 0.45f, 0.45f, 1f);
    private static readonly Vector4 Muted = new(0.65f, 0.65f, 0.65f, 1f);

    private readonly Configuration configuration;
    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IPlayerState playerState;
    private readonly HubClient client;
    private readonly Uploader uploader;
    private readonly SyncService sync;
    private readonly WondrousTailsSync wondrousTails;
    private readonly CancellationTokenSource disposing = new();

    private string serverUrl = string.Empty;
    private string apiKey = string.Empty;
    private bool uploadEnabled;
    private bool showKey;
    private string? saveError;

    // Written by the background "Test connection" task, read by Draw.
    private volatile string? testResult;
    private volatile bool testOk;
    private volatile bool testing;

    public ConfigWindow(
        Configuration configuration,
        IDalamudPluginInterface pluginInterface,
        IPlayerState playerState,
        HubClient client,
        Uploader uploader,
        SyncService sync,
        WondrousTailsSync wondrousTails)
        : base("FC Hub settings##FcHubConfig", ImGuiWindowFlags.AlwaysAutoResize)
    {
        this.configuration = configuration;
        this.pluginInterface = pluginInterface;
        this.playerState = playerState;
        this.client = client;
        this.uploader = uploader;
        this.sync = sync;
        this.wondrousTails = wondrousTails;
    }

    public override void OnOpen()
    {
        serverUrl = configuration.ServerUrl;
        apiKey = configuration.ApiKey;
        uploadEnabled = configuration.UploadEnabled;
        saveError = null;
    }

    public override void Draw()
    {
        ImGui.TextUnformatted("Server URL");
        ImGui.SetNextItemWidth(420);
        ImGui.InputText("##server", ref serverUrl, 256);
        ImGui.TextColored(Muted, "e.g. https://fc-hub.<you>.workers.dev");

        ImGui.Spacing();
        ImGui.TextUnformatted("API key");
        ImGui.SetNextItemWidth(420);
        ImGui.InputText("##apikey", ref apiKey, 128, showKey ? ImGuiInputTextFlags.None : ImGuiInputTextFlags.Password);
        ImGui.SameLine();
        ImGui.Checkbox("Show", ref showKey);
        ImGui.TextColored(Muted, "Your personal key from the FC Hub admin. Stored on this PC in the plugin's config.");

        ImGui.Spacing();
        ImGui.Checkbox("Upload my inventories automatically", ref uploadEnabled);

        ImGui.Spacing();
        if (ImGui.Button("Save"))
        {
            Save();
        }

        ImGui.SameLine();
        using (Disabled(testing))
        {
            if (ImGui.Button(testing ? "Testing..." : "Test connection"))
            {
                TestConnection();
            }
        }

        if (saveError != null)
        {
            ImGui.TextColored(Bad, saveError);
        }

        if (testResult is { } result)
        {
            ImGui.TextColored(testOk ? Good : Bad, result);
        }

        ImGui.Separator();
        var status = uploader.Status;
        ImGui.TextColored(status.IsError ? Bad : Muted, $"Upload status: {status.Message}");
        if (status.LastSuccessAt is { } at)
        {
            ImGui.TextColored(Muted, $"Last upload {Ago(at)}: {status.LastSections:N0} sections, {status.LastItems:N0} items, {(status.LastBytes ?? 0) / 1024.0:0.0} KB");
        }

        ImGui.Spacing();
        using (Disabled(!playerState.IsLoaded))
        {
            if (ImGui.Button("Re-upload everything for this character"))
            {
                uploader.ResetCharacter(playerState.ContentId.ToString());
                sync.RequestRefresh(upload: true);
            }
        }

        if (ImGui.IsItemHovered())
        {
            ImGui.SetTooltip("Normally only changed sections are sent. Use this if the website looks out of date.");
        }

        ImGui.Separator();
        ImGui.TextUnformatted("Wondrous Tails");
        var sharing = configuration.WondrousTailsCharacterName.Length > 0 ? configuration.WondrousTailsCharacterName : "(the first character you log in with)";
        ImGui.TextColored(Muted, $"Shared from: {sharing}. Alts' journals are ignored.");
        if (playerState.IsLoaded && !wondrousTails.IsSharingCharacter)
        {
            if (ImGui.Button($"Share Wondrous Tails from {playerState.CharacterName} instead"))
            {
                wondrousTails.UseCurrentCharacter();
            }
        }
    }

    private void Save()
    {
        saveError = null;
        var trimmedKey = apiKey.Trim();
        if (serverUrl.Trim().Length > 0 && !HubClient.TryParseServerUrl(serverUrl, out _, out var error))
        {
            saveError = error;
            return;
        }

        if (trimmedKey.Length > 0 && !trimmedKey.StartsWith("fch_", StringComparison.Ordinal))
        {
            saveError = "That doesn't look like an FC Hub key (they start with fch_).";
            return;
        }

        var serverChanged = configuration.ServerUrl != serverUrl.Trim();
        configuration.ServerUrl = serverUrl.Trim();
        configuration.ApiKey = trimmedKey;
        configuration.UploadEnabled = uploadEnabled;
        if (serverChanged)
        {
            // A different server has none of our data; start over.
            configuration.UploadedSections.Clear();
        }

        pluginInterface.SavePluginConfig(configuration);
        uploader.SettingsChanged();
        sync.RequestRefresh(upload: true);
    }

    private void TestConnection()
    {
        if (!HubClient.TryParseServerUrl(serverUrl, out var server, out var error))
        {
            testOk = false;
            testResult = error;
            return;
        }

        var key = apiKey.Trim();
        testing = true;
        testResult = null;
        _ = Task.Run(async () =>
        {
            try
            {
                var response = await client.GetMeAsync(server!, key, disposing.Token).ConfigureAwait(false);
                if (response is { Ok: true, Value: { } me })
                {
                    var characters = me.Characters.Count == 0
                        ? "no characters uploaded yet"
                        : string.Join(", ", me.Characters.Select(c => c.Name));
                    testOk = true;
                    testResult = $"Connected as {me.Member.DisplayName} ({characters}).";
                }
                else
                {
                    testOk = false;
                    testResult = response.Error ?? "Connection failed.";
                }
            }
            catch (OperationCanceledException)
            {
                // Plugin unloading.
            }
            catch (Exception e)
            {
                testOk = false;
                testResult = $"Error: {e.Message}";
            }
            finally
            {
                testing = false;
            }
        });
    }

    private static string Ago(DateTimeOffset at)
    {
        var seconds = (DateTimeOffset.UtcNow - at).TotalSeconds;
        return seconds < 90 ? $"{seconds:0}s ago" : $"{seconds / 60:0} min ago";
    }

    private static DisabledScope Disabled(bool disabled) => new(disabled);

    private readonly struct DisabledScope : IDisposable
    {
        private readonly bool active;

        public DisabledScope(bool disabled)
        {
            active = disabled;
            if (active)
            {
                ImGui.BeginDisabled();
            }
        }

        public void Dispose()
        {
            if (active)
            {
                ImGui.EndDisabled();
            }
        }
    }

    public void Dispose()
    {
        disposing.Cancel();
        disposing.Dispose();
    }
}
