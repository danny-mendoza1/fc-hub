using System;
using Dalamud.Game.Command;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Allagan;
using FcHub.Game;
using FcHub.Snapshot;
using FcHub.Windows;

namespace FcHub;

public sealed class Plugin : IDalamudPlugin
{
    private const string Command = "/fchub";

    private readonly IDalamudPluginInterface pluginInterface;
    private readonly ICommandManager commandManager;
    private readonly IChatGui chat;

    private readonly WindowSystem windowSystem = new("FcHub");
    private readonly AllaganToolsIpc allagan;
    private readonly OwnerNameTracker names;
    private readonly ProbeService probe;
    private readonly MainWindow mainWindow;

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        ICommandManager commandManager,
        IChatGui chat,
        IFramework framework,
        IPlayerState playerState,
        IDataManager dataManager,
        IPluginLog log)
    {
        this.pluginInterface = pluginInterface;
        this.commandManager = commandManager;
        this.chat = chat;

        var configuration = pluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
        var version = pluginInterface.Manifest.AssemblyVersion.ToString();

        allagan = new AllaganToolsIpc(pluginInterface, log);
        names = new OwnerNameTracker(framework, playerState, pluginInterface, log, configuration);
        var builder = new SnapshotBuilder(allagan, names, playerState, dataManager, version);
        probe = new ProbeService(framework, chat, log, allagan, builder, pluginInterface.ConfigDirectory);

        mainWindow = new MainWindow(allagan, names, probe);
        windowSystem.AddWindow(mainWindow);

        commandManager.AddHandler(Command, new CommandInfo(OnCommand)
        {
            HelpMessage = "Toggle the FC Hub window. '/fchub dump' writes the current snapshot to a JSON file.",
        });

        pluginInterface.UiBuilder.Draw += windowSystem.Draw;
        pluginInterface.UiBuilder.OpenMainUi += mainWindow.Toggle;
    }

    private void OnCommand(string command, string args)
    {
        switch (args.Trim().ToLowerInvariant())
        {
            case "dump":
                probe.RequestRefresh(writeFile: true);
                break;
            case "":
                mainWindow.Toggle();
                break;
            default:
                chat.Print("[FC Hub] Usage: /fchub (toggle window) · /fchub dump (write snapshot JSON)");
                break;
        }
    }

    public void Dispose()
    {
        pluginInterface.UiBuilder.Draw -= windowSystem.Draw;
        pluginInterface.UiBuilder.OpenMainUi -= mainWindow.Toggle;
        commandManager.RemoveHandler(Command);
        windowSystem.RemoveAllWindows();

        probe.Dispose();
        names.Dispose();
        allagan.Dispose();
    }
}
