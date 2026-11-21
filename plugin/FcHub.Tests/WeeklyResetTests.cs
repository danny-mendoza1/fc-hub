using System;
using System.Globalization;
using FcHub.Game;
using Xunit;

namespace FcHub.Tests;

/// <summary>Same dates as web/test/wondrous-tails.test.ts, so the plugin and the website agree on "this week".</summary>
public class WeeklyResetTests
{
    [Theory]
    [InlineData("2026-11-20T20:00:00Z", "2026-11-17T08:00:00Z")] // Friday: the Tuesday before
    [InlineData("2026-11-24T07:59:59Z", "2026-11-17T08:00:00Z")] // a second before the reset
    [InlineData("2026-11-24T08:00:00Z", "2026-11-24T08:00:00Z")] // the reset itself
    [InlineData("2026-11-23T23:00:00-06:00", "2026-11-17T08:00:00Z")] // Monday night in Chicago is Tuesday 05:00 UTC
    [InlineData("2026-11-24T02:30:00-06:00", "2026-11-24T08:00:00Z")] // Tuesday 08:30 UTC
    public void IsTheLastTuesday0800Utc(string now, string expected)
    {
        var parsedNow = DateTimeOffset.Parse(now, CultureInfo.InvariantCulture);
        Assert.Equal(DateTimeOffset.Parse(expected, CultureInfo.InvariantCulture), WeeklyReset.Last(parsedNow));
    }
}
