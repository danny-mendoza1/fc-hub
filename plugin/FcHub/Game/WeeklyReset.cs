using System;

namespace FcHub.Game;

/// <summary>
/// The game's weekly reset: Tuesdays 08:00 UTC. The website applies the same rule
/// (weeklyResets in web/src/wondrous-tails.ts); tests on both sides use the same dates.
/// </summary>
public static class WeeklyReset
{
    /// <summary>The most recent reset at or before <paramref name="now"/>.</summary>
    public static DateTimeOffset Last(DateTimeOffset now)
    {
        var utc = now.ToUniversalTime();
        var daysSinceTuesday = ((int)utc.DayOfWeek - (int)DayOfWeek.Tuesday + 7) % 7;
        var reset = new DateTimeOffset(utc.Year, utc.Month, utc.Day, 8, 0, 0, TimeSpan.Zero).AddDays(-daysSinceTuesday);
        return reset > utc ? reset.AddDays(-7) : reset;
    }
}
