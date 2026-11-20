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

    /// <summary>Base URL of the FC Hub web API, e.g. https://fc-hub.example.workers.dev</summary>
    public string ServerUrl { get; set; } = string.Empty;

    /// <summary>
    /// This member's API key. Stored in plain text in the plugin's config file on this PC
    /// (like other Dalamud plugin settings); it only grants uploading/searching for this FC Hub.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    public bool UploadEnabled { get; set; }

    /// <summary>
    /// Hash of each section as last accepted by the server, keyed "contentId/ownerId/section".
    /// Only sections whose hash changed are uploaded.
    /// </summary>
    public Dictionary<string, string> UploadedSections { get; set; } = new();
}

[Serializable]
public sealed class KnownOwner
{
    public string Name { get; set; } = string.Empty;
    public OwnerKind Kind { get; set; }
    public ulong ParentId { get; set; }
    public DateTimeOffset LastSeen { get; set; }
}
