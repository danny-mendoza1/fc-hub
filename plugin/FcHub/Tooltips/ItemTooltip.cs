using System;
using Dalamud.Game.Addon.Lifecycle;
using Dalamud.Game.Addon.Lifecycle.AddonArgTypes;
using Dalamud.Game.Text.SeStringHandling;
using Dalamud.Memory;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.UI;
using FFXIVClientStructs.FFXIV.Component.GUI;
using Lumina.Excel;
using Lumina.Excel.Sheets;

namespace FcHub.Tooltips;

/// <summary>
/// Adds FC Hub's lines to the game's item tooltip (the "ItemDetail" window).
///
/// The game fills the tooltip's text fields into a string array, then asks the window to redraw
/// from it. Just before that redraw (Dalamud's <see cref="AddonEvent.PreRequestedUpdate"/>), we
/// append our text to the first visible text field: the description, else the effects, else the
/// levels line. No hooks; Dalamud owns the lifecycle event. Proven in game by test plan 07.
/// Runs on the framework thread.
/// </summary>
public sealed unsafe class ItemTooltip : IDisposable
{
    private const string AddonName = "ItemDetail";

    /// <summary>ItemDetail's number array; <c>IntArray[5]</c> holds which text fields are shown.</summary>
    private const int NumberArrayIndex = 30;
    private const int VisibilityFlagsIndex = 5;

    /// <summary>The item name is field 0 of ItemDetail's string array.</summary>
    private const int ItemNameField = 0;

    /// <summary>
    /// Text fields we can append to, in order of preference (description, effects, levels), with
    /// their visibility bit. Meals only show effects and some gear only shows levels.
    /// </summary>
    private static readonly (int Field, int VisibleFlag)[] Fields = { (13, 2), (16, 256), (23, 32768) };

    private readonly IAddonLifecycle lifecycle;
    private readonly IGameGui gameGui;
    private readonly IPluginLog log;
    private readonly ExcelSheet<Item> items;
    private readonly Func<HoveredItem, string?> textFor;
    private readonly ushort colour;

    /// <summary>
    /// Index of ItemDetail's string array in the game's array table, found by looking for the
    /// array whose item-name field matches the hovered item. -1 until found. It was 27 in test
    /// plan 07; finding it rather than hard-coding it survives a patch that renumbers the arrays.
    /// </summary>
    private int stringArrayIndex = -1;

    /// <param name="textFor">Lines to add for an item, or null to add nothing. Newlines separate lines.</param>
    /// <param name="colour">UIColor row for our text; 0 keeps the tooltip's own colour.</param>
    public ItemTooltip(IAddonLifecycle lifecycle, IGameGui gameGui, IDataManager dataManager, IPluginLog log, Func<HoveredItem, string?> textFor, ushort colour)
    {
        this.lifecycle = lifecycle;
        this.gameGui = gameGui;
        this.log = log;
        this.textFor = textFor;
        this.colour = colour;
        items = dataManager.GetExcelSheet<Item>();

        lifecycle.RegisterListener(AddonEvent.PreRequestedUpdate, AddonName, OnPreRequestedUpdate);
    }

    private void OnPreRequestedUpdate(AddonEvent type, AddonArgs args)
    {
        if (args is not AddonRequestedUpdateArgs ||
            HoveredItem.FromHoveredId(gameGui.HoveredItem) is not { } hovered ||
            textFor(hovered) is not { Length: > 0 } text)
        {
            return;
        }

        var holder = &RaptureAtkModule.Instance()->AtkArrayDataHolder;
        var array = ItemDetailStrings(holder, hovered);
        if (array == null)
        {
            return;
        }

        var numbers = holder->GetNumberArrayData(NumberArrayIndex);
        var visibility = numbers != null && numbers->Size > VisibilityFlagsIndex ? numbers->IntArray[VisibilityFlagsIndex] : -1;

        foreach (var (field, flag) in Fields)
        {
            if ((visibility != -1 && (visibility & flag) == 0) || field >= array->Size || ReadField(array, field) is not { } existing)
            {
                continue;
            }

            // The game often redraws a tooltip from the array we already edited (212 of 448 updates
            // in test plan 07); appending again would repeat our lines.
            if (!existing.TextValue.Contains(text, StringComparison.Ordinal))
            {
                WriteField(array, field, WithText(existing, text));
            }

            return;
        }
    }

    private SeString WithText(SeString existing, string text)
    {
        var builder = new SeStringBuilder().Append(existing);
        if (colour != 0)
        {
            builder.AddUiForeground(colour);
        }

        builder.AddText("\n" + text);
        if (colour != 0)
        {
            builder.AddUiForegroundOff();
        }

        return builder.Build();
    }

    /// <summary>Finds (once) and returns ItemDetail's string array.</summary>
    private StringArrayData* ItemDetailStrings(AtkArrayDataHolder* holder, HoveredItem hovered)
    {
        if (stringArrayIndex >= 0)
        {
            return holder->GetStringArrayData(stringArrayIndex);
        }

        var itemName = items.GetRowOrDefault(hovered.ItemId)?.Name.ExtractText();
        if (string.IsNullOrEmpty(itemName))
        {
            return null;
        }

        for (var i = 0; i < holder->StringArrayCount; i++)
        {
            var candidate = holder->GetStringArrayData(i);
            if (candidate == null || candidate->Size <= Fields[^1].Field)
            {
                continue;
            }

            if (ReadField(candidate, ItemNameField)?.TextValue.Contains(itemName, StringComparison.Ordinal) == true)
            {
                stringArrayIndex = i;
                log.Debug("Item tooltips: ItemDetail's string array is index {Index}", i);
                return candidate;
            }
        }

        return null;
    }

    private static SeString? ReadField(StringArrayData* array, int field)
    {
        var text = array->StringArray[field];
        return text.HasValue ? MemoryHelper.ReadSeStringNullTerminated((nint)text.Value) : null;
    }

    private static void WriteField(StringArrayData* array, int field, SeString value)
    {
        var encoded = value.Encode();
        var bytes = new byte[encoded.Length + 1];
        encoded.CopyTo(bytes, 0);
        fixed (byte* pointer = bytes)
        {
            // managed: the game copies the text into its own memory, so our buffer can go.
            // suppressUpdates: we're already inside the redraw; don't ask for another one.
            array->SetValue(field, pointer, readBeforeWrite: false, managed: true, suppressUpdates: true);
        }
    }

    public void Dispose() => lifecycle.UnregisterListener(AddonEvent.PreRequestedUpdate, AddonName, OnPreRequestedUpdate);
}
