using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Dalamud.Plugin;
using Dalamud.Plugin.Ipc;
using Dalamud.Plugin.Ipc.Exceptions;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game;

namespace FcHub.Allagan;

/// <summary>
/// Thin wrapper around the IPC surface that Allagan Tools (internal name "InventoryTools") exposes.
/// See InventoryTools/IPC/IPCService.cs in the Allagan Tools repo for the provider side.
/// All Invoke* calls must happen on the framework thread: Allagan Tools reads its in-memory
/// inventories without locking.
/// </summary>
public sealed class AllaganToolsIpc : IDisposable
{
    public const string InternalName = "InventoryTools";

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly IPluginLog log;

    private readonly ICallGateSubscriber<bool> isInitialized;
    private readonly ICallGateSubscriber<ulong> currentCharacter;
    private readonly ICallGateSubscriber<bool, HashSet<ulong>> charactersOwnedByActive;
    private readonly ICallGateSubscriber<ulong, HashSet<ulong[]>> characterItems;

    private readonly ICallGateSubscriber<bool, bool> initialized;
    private readonly ICallGateSubscriber<(uint, InventoryItem.ItemFlags, ulong, uint), bool> itemAdded;
    private readonly ICallGateSubscriber<(uint, InventoryItem.ItemFlags, ulong, uint), bool> itemRemoved;
    private readonly ICallGateSubscriber<ulong?, bool> retainerChanged;

    private long itemAddedCount;
    private long itemRemovedCount;
    private long retainerChangedCount;
    private long initializedCount;
    private long lastEventTicks;

    /// <summary>Raised whenever Allagan Tools reports an inventory or retainer change.</summary>
    public event Action? Changed;

    public AllaganToolsIpc(IDalamudPluginInterface pluginInterface, IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.log = log;

        isInitialized = pluginInterface.GetIpcSubscriber<bool>("AllaganTools.IsInitialized");
        currentCharacter = pluginInterface.GetIpcSubscriber<ulong>("AllaganTools.CurrentCharacter");
        charactersOwnedByActive = pluginInterface.GetIpcSubscriber<bool, HashSet<ulong>>("AllaganTools.GetCharactersOwnedByActive");
        characterItems = pluginInterface.GetIpcSubscriber<ulong, HashSet<ulong[]>>("AllaganTools.GetCharacterItems");

        initialized = pluginInterface.GetIpcSubscriber<bool, bool>("AllaganTools.Initialized");
        itemAdded = pluginInterface.GetIpcSubscriber<(uint, InventoryItem.ItemFlags, ulong, uint), bool>("AllaganTools.ItemAdded");
        itemRemoved = pluginInterface.GetIpcSubscriber<(uint, InventoryItem.ItemFlags, ulong, uint), bool>("AllaganTools.ItemRemoved");
        retainerChanged = pluginInterface.GetIpcSubscriber<ulong?, bool>("AllaganTools.RetainerChanged");

        initialized.Subscribe(OnInitialized);
        itemAdded.Subscribe(OnItemAdded);
        itemRemoved.Subscribe(OnItemRemoved);
        retainerChanged.Subscribe(OnRetainerChanged);
    }

    public long ItemAddedCount => Interlocked.Read(ref itemAddedCount);
    public long ItemRemovedCount => Interlocked.Read(ref itemRemovedCount);
    public long RetainerChangedCount => Interlocked.Read(ref retainerChangedCount);
    public long InitializedCount => Interlocked.Read(ref initializedCount);

    public DateTimeOffset? LastEventAt
    {
        get
        {
            var ticks = Interlocked.Read(ref lastEventTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    /// <summary>Whether the Allagan Tools plugin is installed and currently loaded.</summary>
    public bool IsPluginLoaded =>
        pluginInterface.InstalledPlugins.Any(p => p.InternalName == InternalName && p.IsLoaded);

    /// <summary>Whether Allagan Tools has registered its IPC and reports itself initialized.</summary>
    public bool IsReady()
    {
        try
        {
            return isInitialized.InvokeFunc();
        }
        catch (IpcNotReadyError)
        {
            return false;
        }
    }

    public ulong GetCurrentCharacter() => currentCharacter.InvokeFunc();

    /// <summary>IDs of everything owned by the logged-in character: retainers, FC chest, housing (and the character itself if requested).</summary>
    public HashSet<ulong> GetOwnedByActive(bool includeOwner) => charactersOwnedByActive.InvokeFunc(includeOwner);

    /// <summary>Raw items for one owner, in Allagan Tools' <c>InventoryItem.ToNumeric()</c> layout.</summary>
    public IReadOnlyList<AllaganItem> GetItems(ulong ownerId)
    {
        var raw = characterItems.InvokeFunc(ownerId) ?? new HashSet<ulong[]>();
        var items = new List<AllaganItem>(raw.Count);
        foreach (var row in raw)
        {
            if (AllaganItem.TryParse(row, out var item))
            {
                items.Add(item);
            }
        }

        return items;
    }

    private void OnInitialized(bool value)
    {
        Interlocked.Increment(ref initializedCount);
        MarkEvent();
        log.Information("Allagan Tools reported initialized");
    }

    private void OnItemAdded((uint, InventoryItem.ItemFlags, ulong, uint) change)
    {
        Interlocked.Increment(ref itemAddedCount);
        MarkEvent();
    }

    private void OnItemRemoved((uint, InventoryItem.ItemFlags, ulong, uint) change)
    {
        Interlocked.Increment(ref itemRemovedCount);
        MarkEvent();
    }

    private void OnRetainerChanged(ulong? retainerId)
    {
        Interlocked.Increment(ref retainerChangedCount);
        MarkEvent();
    }

    private void MarkEvent()
    {
        Interlocked.Exchange(ref lastEventTicks, DateTimeOffset.UtcNow.UtcTicks);
        Changed?.Invoke();
    }

    public void Dispose()
    {
        initialized.Unsubscribe(OnInitialized);
        itemAdded.Unsubscribe(OnItemAdded);
        itemRemoved.Unsubscribe(OnItemRemoved);
        retainerChanged.Unsubscribe(OnRetainerChanged);
    }
}
