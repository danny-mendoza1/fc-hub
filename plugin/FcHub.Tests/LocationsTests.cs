using FcHub.Snapshot;
using Xunit;

namespace FcHub.Tests;

public class LocationsTests
{
    [Theory]
    [InlineData(0u, 1)] // Inventory1
    [InlineData(3u, 4)] // Inventory4
    [InlineData(4001u, 2)] // SaddleBag2
    [InlineData(10006u, 7)] // RetainerPage7
    [InlineData(20010u, 11)] // FreeCompanyPage11
    [InlineData(27001u, 1)] // HousingInteriorStoreroom1
    public void PagesAreOneBased(uint container, int page) => Assert.Equal<int?>(page, Locations.PageOf(container));

    [Theory]
    [InlineData(2000u)] // Currency
    [InlineData(3500u)] // armoury main hand
    [InlineData(10007u)]
    public void ContainersWithoutPagesHaveNone(uint container) => Assert.Null(Locations.PageOf(container));

    [Theory]
    [InlineData(3500u, "main hand")]
    [InlineData(3300u, "rings")]
    [InlineData(3209u, "bracelets")]
    public void ArmourySectionsAreNamed(uint container, string name) => Assert.Equal(name, Locations.ArmourySection(container));
}
