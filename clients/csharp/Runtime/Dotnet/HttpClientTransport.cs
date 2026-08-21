#if !UNITY
using System;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Wardx
{
    public sealed class HttpClientTransport : ISyncTransport
    {
        readonly HttpClient _http;
        readonly Uri _url;
        readonly string _projectKey;
        readonly bool _ownsClient;

        public HttpClientTransport(string endpoint, string projectKey, int httpTimeoutMs, HttpClient http = null)
        {
            _url = SyncUrl(endpoint);
            _projectKey = projectKey;
            if (http != null)
            {
                _http = http;
                _ownsClient = false;
            }
            else
            {
                _http = new HttpClient();
                _http.Timeout = TimeSpan.FromMilliseconds(httpTimeoutMs);
                _ownsClient = true;
            }
        }

        public async Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            using (var content = new ByteArrayContent(gzippedBody))
            {
                content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                content.Headers.ContentEncoding.Add("gzip");
                using (var request = new HttpRequestMessage(HttpMethod.Post, _url) { Content = content })
                {
                    request.Headers.TryAddWithoutValidation("X-Wardx-Key", _projectKey);
                    request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
                    using (var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false))
                    {
                        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                        var status = (int)response.StatusCode;
                        return new SyncResult(status >= 200 && status < 300, status, text);
                    }
                }
            }
        }

        public void Close()
        {
            if (_ownsClient) _http.Dispose();
        }

        public static Uri SyncUrl(string endpoint)
        {
            var url = new Uri(endpoint);
            if (url.AbsolutePath == "/" || url.AbsolutePath == "")
            {
                return new Uri(url, "/v1/sync");
            }
            return url;
        }
    }

    static class DotnetBootstrap
    {
        public static WardxClient Start(Settings settings)
        {
            var transport = new HttpClientTransport(settings.Endpoint, settings.ProjectKey, settings.HttpTimeoutMs);
            var client = new WardxClient(
                settings,
                transport,
                () =>
                {
                    try { return Process.GetCurrentProcess().WorkingSet64; }
                    catch { return 0; }
                },
                new SdkIdentity
                {
                    Name = "wardx-csharp",
                    Version = SdkDefaults.Version,
                    Platform = "csharp"
                }
            );

            var running = true;
            Timer aggregateTimer = null;
            Timer syncTimer = null;
            void Stop()
            {
                running = false;
                aggregateTimer?.Dispose();
                syncTimer?.Dispose();
            }

            aggregateTimer = new Timer(
                _ =>
                {
                    if (!running) return;
                    try { client.AggregateTick(); }
                    catch { }
                },
                null,
                settings.AggregateIntervalMs,
                settings.AggregateIntervalMs
            );

            void ScheduleSync()
            {
                if (!running) return;
                var delay = Math.Max(1, Settings.NextSyncDelayMs(settings));
                syncTimer?.Dispose();
                syncTimer = new Timer(
                    _ =>
                    {
                        if (!running) return;
                        client.EnqueueSync(default).ContinueWith(_ => ScheduleSync());
                    },
                    null,
                    delay,
                    Timeout.Infinite
                );
            }

            client.AttachScheduler(Stop);
            ScheduleSync();
            _ = client.EnqueueSync(new SyncFlags { Bootstrap = true });
            return client;
        }
    }
}
#endif
