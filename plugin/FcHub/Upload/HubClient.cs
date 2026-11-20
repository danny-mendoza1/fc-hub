using System;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace FcHub.Upload;

/// <summary>Minimal HTTP client for the FC Hub web API.</summary>
public sealed class HubClient : IDisposable
{
    private readonly HttpClient http;

    public HubClient(string pluginVersion)
    {
        http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("FcHub", pluginVersion));
    }

    /// <summary>
    /// Accepts https URLs, or plain http only for localhost (local development). Keys must never
    /// travel over plain http to another machine.
    /// </summary>
    public static bool TryParseServerUrl(string input, out Uri? uri, out string? error)
    {
        uri = null;
        error = null;
        if (!Uri.TryCreate(input.Trim().TrimEnd('/'), UriKind.Absolute, out var parsed))
        {
            error = "Not a valid URL.";
            return false;
        }

        var isLocal = parsed.IsLoopback;
        if (parsed.Scheme != Uri.UriSchemeHttps && !(isLocal && parsed.Scheme == Uri.UriSchemeHttp))
        {
            error = "Use an https:// URL (plain http is only allowed for localhost).";
            return false;
        }

        // Normalise to a trailing slash so relative API paths keep any path prefix (e.g. a reverse proxy).
        uri = new Uri(parsed.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/");
        return true;
    }

    public Task<HubResponse<MeResponse>> GetMeAsync(Uri server, string apiKey, CancellationToken cancellationToken)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, new Uri(server, "api/v1/me"));
        return SendAsync<MeResponse>(request, apiKey, cancellationToken);
    }

    /// <summary>Uploads a gzip-compressed inventory snapshot.</summary>
    public Task<HubResponse<UploadResult>> UploadAsync(Uri server, string apiKey, UploadPayload payload, CancellationToken cancellationToken) =>
        PostJsonAsync<UploadPayload, UploadResult>(server, "api/v1/snapshots", apiKey, payload, cancellationToken);

    /// <summary>POSTs a gzip-compressed JSON body and parses the JSON response.</summary>
    public Task<HubResponse<TResult>> PostJsonAsync<TPayload, TResult>(Uri server, string path, string apiKey, TPayload payload, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, UploadJson.Options);
        using var compressed = new MemoryStream();
        using (var gzip = new GZipStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(json);
        }

        var content = new ByteArrayContent(compressed.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        content.Headers.ContentEncoding.Add("gzip");

        var request = new HttpRequestMessage(HttpMethod.Post, new Uri(server, path)) { Content = content };
        return SendAsync<TResult>(request, apiKey, cancellationToken, compressedBytes: content.Headers.ContentLength);
    }

    private async Task<HubResponse<T>> SendAsync<T>(HttpRequestMessage request, string apiKey, CancellationToken cancellationToken, long? compressedBytes = null)
    {
        using (request)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            try
            {
                using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
                var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                var status = (int)response.StatusCode;

                if (response.IsSuccessStatusCode)
                {
                    var value = JsonSerializer.Deserialize<T>(body, UploadJson.Options);
                    return new HubResponse<T>(true, status, value, null, compressedBytes);
                }

                return new HubResponse<T>(false, status, default, DescribeError(status, body), compressedBytes);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new HubResponse<T>(false, 0, default, "Timed out contacting the server.", compressedBytes);
            }
            catch (HttpRequestException e)
            {
                return new HubResponse<T>(false, 0, default, $"Network error: {e.Message}", compressedBytes);
            }
        }
    }

    private static string DescribeError(int status, string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var error) &&
                error.TryGetProperty("message", out var message))
            {
                var details = error.TryGetProperty("details", out var d) ? $" ({d})" : string.Empty;
                return $"HTTP {status}: {message.GetString()}{details}";
            }
        }
        catch (JsonException)
        {
            // Not our API's error format (proxy page, etc.).
        }

        return $"HTTP {status}";
    }

    public void Dispose() => http.Dispose();
}

public sealed record HubResponse<T>(bool Ok, int StatusCode, T? Value, string? Error, long? CompressedBytes);
