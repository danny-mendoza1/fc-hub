using System;
using System.Collections.Generic;
using Dalamud.Configuration;
using FcHub.Snapshot;

namespace FcHub;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 1;

    /// <summary>
    /// Names we've seen for retainers / FC / characters, keyed by Allagan Tools owner id.
    /// Allagan Tools IPC only returns ids, and the game only knows retainer names after the
    /// summoning bell is used, so we remember them across sessions.
    /// </summary>
    public Dictionary<ulong, KnownOwner> KnownOwners { get; set; } = new();
}

[Serializable]
public sealed class KnownOwner
{
    public string Name { get; set; } = string.Empty;
    public OwnerKind Kind { get; set; }
    public ulong ParentId { get; set; }
    public DateTimeOffset LastSeen { get; set; }
}
