using Dalamud.Game.Command;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using FcHub.Allagan;
using FcHub.Game;
using FcHub.Snapshot;
using FcHub.Upload;
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
    private readonly HubClient hubClient;
    private readonly UploadChannel uploadChannel;
    private readonly Uploader uploader;
    private readonly SyncService sync;
    private readonly WondrousTailsSync wondrousTails;
    private readonly MainWindow mainWindow;
    private readonly ConfigWindow configWindow;

    public Plugin(
        IDalamudPluginInterface pluginInterface,
        ICommandManager commandManager,
        IChatGui chat,
        IFramework framework,
        IClientState clientState,
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
        hubClient = new HubClient(version);
        uploadChannel = new UploadChannel(configuration, framework, log);
        uploader = new Uploader(configuration, pluginInterface, log, hubClient, uploadChannel, version);
        sync = new SyncService(framework, chat, log, allagan, builder, uploader, pluginInterface.ConfigDirectory);
        wondrousTails = new WondrousTailsSync(
            framework, clientState, playerState, pluginInterface, log, configuration, hubClient, uploadChannel, new WondrousTailsReader(dataManager), version);

        configWindow = new ConfigWindow(configuration, pluginInterface, playerState, hubClient, uploader, sync, wondrousTails);
        mainWindow = new MainWindow(allagan, names, sync, uploader, wondrousTails, configuration, configWindow.Toggle);
        windowSystem.AddWindow(mainWindow);
        windowSystem.AddWindow(configWindow);

        commandManager.AddHandler(Command, new CommandInfo(OnCommand)
        {
            HelpMessage = "Toggle the FC Hub window. '/fchub config' opens settings, '/fchub upload' uploads now, '/fchub dump' writes the snapshot JSON.",
        });

        pluginInterface.UiBuilder.Draw += windowSystem.Draw;
        pluginInterface.UiBuilder.OpenMainUi += mainWindow.Toggle;
        pluginInterface.UiBuilder.OpenConfigUi += configWindow.Toggle;
    }

    private void OnCommand(string command, string args)
    {
        switch (args.Trim().ToLowerInvariant())
        {
            case "":
                mainWindow.Toggle();
                break;
            case "config":
            case "settings":
                configWindow.Toggle();
                break;
            case "upload":
                sync.RequestRefresh(upload: true);
                wondrousTails.RequestRead();
                break;
            case "dump":
                sync.RequestRefresh(writeFile: true);
                break;
            default:
                chat.Print("[FC Hub] Usage: /fchub · /fchub config · /fchub upload · /fchub dump");
                break;
        }
    }

    public void Dispose()
    {
        pluginInterface.UiBuilder.Draw -= windowSystem.Draw;
        pluginInterface.UiBuilder.OpenMainUi -= mainWindow.Toggle;
        pluginInterface.UiBuilder.OpenConfigUi -= configWindow.Toggle;
        commandManager.RemoveHandler(Command);
        windowSystem.RemoveAllWindows();

        sync.Dispose();
        wondrousTails.Dispose();
        uploadChannel.Dispose();
        configWindow.Dispose();
        hubClient.Dispose();
        names.Dispose();
        allagan.Dispose();
    }
}
