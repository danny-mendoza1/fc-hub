using System;
using System.Collections.Generic;
using Dalamud.Plugin.Services;
using Lumina.Excel;
using Lumina.Excel.Sheets;
using CsPlayerState = FFXIVClientStructs.FFXIV.Client.Game.UI.PlayerState;

namespace FcHub.Game;

/// <summary>
/// Reads the logged-in character's Wondrous Tails journal straight from game memory
/// (FFXIVClientStructs PlayerState "WeeklyBingo" fields). Read-only: no hooks, no game actions.
/// Must be called on the framework thread.
/// </summary>
public sealed unsafe class WondrousTailsReader
{
    public const int SlotCount = 16;

    private readonly ExcelSheet<WeeklyBingoOrderData> orderSheet;

    public WondrousTailsReader(IDataManager dataManager)
    {
        orderSheet = dataManager.GetExcelSheet<WeeklyBingoOrderData>();
    }

    public WondrousTailsState? Read()
    {
        var state = CsPlayerState.Instance();
        if (state == null || !state->IsLoaded)
        {
            return null;
        }

        if (!state->HasWeeklyBingoJournal)
        {
            return WondrousTailsState.NoJournal(state->WeeklyBingoNumSecondChancePoints);
        }

        var orderIds = state->WeeklyBingoOrderData;
        var slots = new List<WondrousTailsSlot>(SlotCount);
        for (var i = 0; i < SlotCount && i < orderIds.Length; i++)
        {
            var orderId = (uint)orderIds[i];
            var status = state->GetWeeklyBingoTaskStatus(i) switch
            {
                CsPlayerState.WeeklyBingoTaskStatus.Claimable => SlotStatus.Claimable,
                CsPlayerState.WeeklyBingoTaskStatus.Claimed => SlotStatus.Claimed,
                _ => SlotStatus.Open,
            };

            var name = $"Objective #{orderId}";
            uint iconId = 0;
            uint type = 0;
            uint dataId = 0;
            if (orderSheet.GetRowOrDefault(orderId) is { } row)
            {
                var text = row.Text.ValueNullable?.Description.ExtractText();
                if (!string.IsNullOrWhiteSpace(text)) name = text;
                iconId = (uint)row.Icon;
                type = (uint)row.Type;
                dataId = row.Data.RowId;
            }

            slots.Add(new WondrousTailsSlot(i, orderId, name, iconId, type, dataId, status));
        }

        var expires = DateTimeOffset.FromUnixTimeSeconds(state->GetWeeklyBingoExpireUnixTimestamp());
        return new WondrousTailsState(
            HasJournal: true,
            IsExpired: state->IsWeeklyBingoExpired(),
            ExpiresAt: expires,
            SecondChancePoints: state->WeeklyBingoNumSecondChancePoints,
            StickersPlaced: state->WeeklyBingoNumPlacedStickers,
            Slots: slots);
    }
}

public enum SlotStatus
{
    /// <summary>Not done yet.</summary>
    Open,

    /// <summary>Done, sticker not placed yet.</summary>
    Claimable,

    /// <summary>Done and sticker placed.</summary>
    Claimed,
}

/// <param name="Type">WeeklyBingoOrderData.Type (0 = a specific duty; others are categories). Kept for later category matching.</param>
/// <param name="DataId">WeeklyBingoOrderData.Data row id (the duty for Type 0).</param>
public sealed record WondrousTailsSlot(int Index, uint OrderId, string Name, uint IconId, uint Type, uint DataId, SlotStatus Status);

public sealed record WondrousTailsState(
    bool HasJournal,
    bool IsExpired,
    DateTimeOffset? ExpiresAt,
    uint SecondChancePoints,
    int StickersPlaced,
    IReadOnlyList<WondrousTailsSlot> Slots)
{
    public static WondrousTailsState NoJournal(uint secondChancePoints) =>
        new(false, false, null, secondChancePoints, 0, Array.Empty<WondrousTailsSlot>());
}
