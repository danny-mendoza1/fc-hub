using System;
using System.Linq;
using FcHub.Snapshot;
using FcHub.Tooltips;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

public class FcHoldingsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);

    private static FcHoldingsSection Section(string character, string section, OwnerKind kind = OwnerKind.Character, string? ownerName = null, int memberId = 1, DateTimeOffset? updatedAt = null) =>
        new("1", kind, ownerName ?? character, section, memberId, "Member", character, updatedAt ?? Now);

    private static FcHoldingsWire Wire(FcHoldingsSection[] sections, params FcHoldingsItem[] items) => new(sections, items);

    private static FcHoldingsItem Item(uint itemId, bool isHq, params (uint Section, uint Quantity)[] places) =>
        new(itemId, "Name", 0, isHq, places.Select(p => new[] { p.Section, p.Quantity, 1u }).ToList());

    [Fact]
    public void ListsEachCharactersLargestStacksFirst()
    {
        var holdings = FcHoldings.From(Wire(
            new[] { Section("Bea", "CharacterBags"), Section("Al", "CharacterSaddleBags", memberId: 2), Section("Bea", "RetainerBags", OwnerKind.Retainer, "Noodle") },
            Item(5111, false, (0, 3), (1, 7), (2, 40))));

        Assert.Equal(
            "FC mates: 50\n" +
            "      Al · Saddlebag · 7\n" +
            "      Bea · Retainer Noodle · 40\n" +
            "      Bea · Inventory · 3",
            holdings.TextFor(5111, Now));
        Assert.Equal(2, holdings.MemberCount);
    }

    [Fact]
    public void ListsNqAndHqTogetherAndMarksHq()
    {
        var holdings = FcHoldings.From(Wire(new[] { Section("Al", "CharacterBags") }, Item(4554, false, (0, 17)), Item(4554, true, (0, 2))));

        Assert.Equal("FC mates: 19\n      Al · Inventory · 17\n      Al · Inventory · 2 ", holdings.TextFor(4554, Now));
        Assert.Equal(1, holdings.ItemCount);
    }

    [Fact]
    public void CapsTheLinesAndCountsTheRest()
    {
        var sections = Enumerable.Range(0, FcHoldings.MaxLines + 2).Select(i => Section($"C{i:00}", "CharacterBags")).ToArray();
        var holdings = FcHoldings.From(Wire(sections, Item(1, false, sections.Select((_, i) => ((uint)i, 1u)).ToArray())));

        var lines = holdings.TextFor(1, Now)!.Split('\n');
        Assert.Equal($"FC mates: {FcHoldings.MaxLines + 2}", lines[0]);
        Assert.Equal(FcHoldings.MaxLines + 2, lines.Length);
        Assert.Equal("      2 more places", lines[^1]);
    }

    [Fact]
    public void ShowsTheAgeOfDataOlderThanADay()
    {
        var holdings = FcHoldings.From(Wire(
            new[] { Section("Al", "RetainerBags", OwnerKind.Retainer, "Noodle", updatedAt: Now.AddDays(-3).AddHours(-2)), Section("Bea", "CharacterBags", updatedAt: Now.AddHours(-23)) },
            Item(5111, false, (0, 9), (1, 1))));

        Assert.Equal("FC mates: 10\n      Al · Retainer Noodle · 9 · 3d\n      Bea · Inventory · 1", holdings.TextFor(5111, Now));
    }

    [Fact]
    public void HasNothingForItemsNoMateHolds()
    {
        Assert.Null(FcHoldings.Empty.TextFor(5111, Now));
        Assert.Null(FcHoldings.From(Wire(new[] { Section("Al", "CharacterBags") }, Item(1, false, (0, 1)))).TextFor(2, Now));
    }

    [Fact]
    public void SkipsPlacesThatPointAtNoSection()
    {
        var holdings = FcHoldings.From(Wire(new[] { Section("Al", "CharacterBags") }, Item(1, false, (0, 1), (5, 99))));

        Assert.Equal("FC mates: 1\n      Al · Inventory · 1", holdings.TextFor(1, Now));
    }
}
