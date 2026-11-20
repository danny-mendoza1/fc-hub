using System;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Snapshot;
using FFXIVClientStructs.FFXIV.Client.Game;
using FFXIVClientStructs.FFXIV.Client.UI.Info;

namespace FcHub.Game;

/// <summary>
/// Learns display names for owners (character, retainers, FC) from game memory and remembers
/// them in <see cref="Configuration.KnownOwners"/>. Polls every couple of seconds on the
/// framework thread; reads are cheap and touch no game state.
/// </summary>
public sealed unsafe class OwnerNameTracker : IDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);

    private readonly IFramework framework;
    private readonly IPlayerState playerState;
    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IPluginLog log;
    private readonly Configuration configuration;
    private DateTime nextPoll = DateTime.MinValue;

    public OwnerNameTracker(
        IFramework framework,
        IPlayerState playerState,
        IDalamudPluginInterface pluginInterface,
        IPluginLog log,
        Configuration configuration)
    {
        this.framework = framework;
        this.playerState = playerState;
        this.pluginInterface = pluginInterface;
        this.log = log;
        this.configuration = configuration;
        framework.Update += OnUpdate;
    }

    /// <summary>Whether the game's retainer list is currently loaded (true after using a summoning bell).</summary>
    public bool RetainerListReady { get; private set; }

    public int RetainerCount { get; private set; }

    public string? NameOf(ulong ownerId) =>
        configuration.KnownOwners.TryGetValue(ownerId, out var known) && known.Name.Length > 0 ? known.Name : null;

    public OwnerKind? KindOf(ulong ownerId) =>
        configuration.KnownOwners.TryGetValue(ownerId, out var known) ? known.Kind : null;

    private void OnUpdate(IFramework fw)
    {
        var now = DateTime.UtcNow;
        if (now < nextPoll)
        {
            return;
        }

        nextPoll = now + PollInterval;

        if (!playerState.IsLoaded || playerState.ContentId == 0)
        {
            return;
        }

        try
        {
            var changed = false;
            var characterId = playerState.ContentId;
            changed |= Remember(characterId, playerState.CharacterName, OwnerKind.Character, 0);
            changed |= ReadRetainers(characterId);
            changed |= ReadFreeCompany(characterId);

            if (changed)
            {
                pluginInterface.SavePluginConfig(configuration);
            }
        }
        catch (Exception e)
        {
            log.Error(e, "Failed to read owner names");
        }
    }

    private bool ReadRetainers(ulong characterId)
    {
        var manager = RetainerManager.Instance();
        RetainerListReady = manager != null && manager->IsReady;
        if (!RetainerListReady)
        {
            return false;
        }

        var changed = false;
        var count = 0;
        var retainers = manager->Retainers;
        for (var i = 0; i < retainers.Length; i++)
        {
            var retainer = retainers[i];
            if (retainer.RetainerId == 0)
            {
                continue;
            }

            count++;
            changed |= Remember(retainer.RetainerId, retainer.NameString.Trim(), OwnerKind.Retainer, characterId);
        }

        RetainerCount = count;
        return changed;
    }

    private bool ReadFreeCompany(ulong characterId)
    {
        var infoModule = InfoModule.Instance();
        if (infoModule == null)
        {
            return false;
        }

        var proxy = (InfoProxyFreeCompany*)infoModule->GetInfoProxyById(InfoProxyId.FreeCompany);
        if (proxy == null || proxy->Id == 0)
        {
            return false;
        }

        return Remember(proxy->Id, proxy->NameString.Trim(), OwnerKind.FreeCompany, characterId);
    }

    private bool Remember(ulong id, string name, OwnerKind kind, ulong parentId)
    {
        if (id == 0 || string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        if (configuration.KnownOwners.TryGetValue(id, out var existing) &&
            existing.Name == name && existing.Kind == kind && existing.ParentId == parentId)
        {
            return false;
        }

        configuration.KnownOwners[id] = new KnownOwner
        {
            Name = name,
            Kind = kind,
            ParentId = parentId,
            LastSeen = DateTimeOffset.UtcNow,
        };
        log.Debug("Learned {Kind} name {Name} for {Id}", kind, name, id);
        return true;
    }

    public void Dispose()
    {
        framework.Update -= OnUpdate;
    }
}
