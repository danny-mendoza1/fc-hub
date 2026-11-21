using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FcHub.Upload;

/// <summary>
/// SHA-256 of a payload's upload JSON, with optional text before/after it, for "has this changed
/// since the server last accepted it?" checks. Every upload type uses this, so they all skip
/// unchanged data the same way.
/// </summary>
/// <remarks>
/// The byte layout (prefix, JSON, suffix) is what members' saved hashes were computed with:
/// changing it makes every plugin re-send everything once. Tests pin it.
/// </remarks>
public static class ContentHash
{
    public static string Of<T>(T value, string prefix = "", string suffix = "")
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(value, UploadJson.Options);
        var head = Encoding.UTF8.GetBytes(prefix);
        var tail = Encoding.UTF8.GetBytes(suffix);
        var buffer = new byte[head.Length + json.Length + tail.Length];
        head.CopyTo(buffer, 0);
        json.CopyTo(buffer, head.Length);
        tail.CopyTo(buffer, head.Length + json.Length);
        return Convert.ToHexString(SHA256.HashData(buffer));
    }
}
