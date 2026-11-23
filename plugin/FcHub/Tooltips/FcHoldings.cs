using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using FcHub.Allagan;
using FcHub.Snapshot;
using FcHub.Upload;

namespace FcHub.Tooltips;

/// <summary>
/// The other members' storage, indexed by item id, and the tooltip text for an item:
/// <code>
/// FC mates: 59
///       Alice Example · Retainer Sir-noodle · 40
///       Alice Example · Inventory · 17 (HQ glyph when HQ)
/// </code>
/// NQ and HQ are listed together (they're the same item to someone looking for it), the largest
/// stacks of each character first. Pure (no game types), so it's unit-tested.
/// </summary>
public sealed class FcHoldings
{
    /// <summary>Most place lines in one tooltip; the rest become "N more places". 12 fit in test plan 07.</summary>
    public const int MaxLines = 10;

    /// <summary>Data older than this gets its age shown, since a retainer's contents can be weeks old.</summary>
    public static readonly TimeSpan ShowAgeAfter = TimeSpan.FromHours(24);

    public static readonly FcHoldings Empty = new(new Dictionary<uint, List<Holding>>(), 0);

    private const string Indent = "      ";
    private const char HqGlyph = '';

    private readonly Dictionary<uint, List<Holding>> byItem;

    private FcHoldings(Dictionary<uint, List<Holding>> byItem, int memberCount)
    {
        this.byItem = byItem;
        MemberCount = memberCount;
    }

    /// <summary>Distinct items (NQ and HQ counted once).</summary>
    public int ItemCount => byItem.Count;

    public int MemberCount { get; }

    public static FcHoldings From(FcHoldingsWire wire)
    {
        var byItem = new Dictionary<uint, List<Holding>>();
        foreach (var item in wire.Items)
        {
            foreach (var place in item.Places)
            {
                if (place.Length < 2 || place[0] >= wire.Sections.Count)
                {
                    continue;
                }

                var section = wire.Sections[(int)place[0]];
                if (!byItem.TryGetValue(item.ItemId, out var holdings))
                {
                    byItem[item.ItemId] = holdings = new List<Holding>();
                }

                holdings.Add(new Holding(section.Character, PlaceLabel(section), place[1], item.IsHq, section.UpdatedAt));
            }
        }

        foreach (var holdings in byItem.Values)
        {
            holdings.Sort((a, b) =>
            {
                var byCharacter = string.CompareOrdinal(a.Character, b.Character);
                return byCharacter != 0 ? byCharacter : b.Quantity.CompareTo(a.Quantity);
            });
        }

        return new FcHoldings(byItem, wire.Sections.Select(s => s.MemberId).Distinct().Count());
    }

    /// <summary>The lines to add to an item's tooltip, or null when no mate holds it.</summary>
    public string? TextFor(uint itemId, DateTimeOffset now)
    {
        if (!byItem.TryGetValue(itemId, out var holdings) || holdings.Count == 0)
        {
            return null;
        }

        var text = new StringBuilder($"FC mates: {holdings.Sum(h => (long)h.Quantity):N0}");
        foreach (var holding in holdings.Take(MaxLines))
        {
            text.Append($"\n{Indent}{holding.Character} · {holding.Place} · {holding.Quantity:N0}");
            if (holding.IsHq)
            {
                text.Append(' ').Append(HqGlyph);
            }

            if (now - holding.UpdatedAt > ShowAgeAfter)
            {
                text.Append($" · {(int)(now - holding.UpdatedAt).TotalDays}d");
            }
        }

        if (holdings.Count > MaxLines)
        {
            var more = holdings.Count - MaxLines;
            text.Append($"\n{Indent}{more} more place{(more == 1 ? "" : "s")}");
        }

        return text.ToString();
    }

    /// <summary>"Inventory", "Saddlebag", "Crystals", or "Retainer «name»" for a retainer's bags.</summary>
    private static string PlaceLabel(FcHoldingsSection section)
    {
        var label = Enum.TryParse<AllaganCategory>(section.Section, out var category) ? Locations.CategoryLabel(category) : section.Section;
        return section.OwnerKind == OwnerKind.Retainer && !string.IsNullOrWhiteSpace(section.OwnerName)
            ? $"{label} {section.OwnerName}"
            : label;
    }

    private sealed record Holding(string Character, string Place, uint Quantity, bool IsHq, DateTimeOffset UpdatedAt);
}
