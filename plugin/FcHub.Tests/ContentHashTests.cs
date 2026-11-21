using System;
using System.Security.Cryptography;
using System.Text;
using FcHub.Upload;
using Xunit;

namespace FcHub.Tests;

public class ContentHashTests
{
    /// <summary>
    /// Members' plugin configs store these hashes. If the layout changed, every plugin would
    /// re-send everything once, so it's pinned here.
    /// </summary>
    [Fact]
    public void IsSha256OfPrefixThenCamelCaseJsonThenSuffix()
    {
        var expected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("pre{\"itemCount\":1}suf")));
        Assert.Equal(expected, ContentHash.Of(new { ItemCount = 1 }, prefix: "pre", suffix: "suf"));
    }

    [Fact]
    public void ChangesWhenTheValueChanges()
    {
        Assert.NotEqual(ContentHash.Of(new { ItemCount = 1 }), ContentHash.Of(new { ItemCount = 2 }));
        Assert.Equal(ContentHash.Of(new { ItemCount = 1 }), ContentHash.Of(new { ItemCount = 1 }));
    }
}
