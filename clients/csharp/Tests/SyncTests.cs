using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Wardx.Tests
{
    sealed class MemoryTransport : ISyncTransport
    {
        public string LastJson;
        public string Response = "{\"ok\":true,\"serverTime\":1,\"configVersion\":13,\"config\":{\"values\":{\"message.delayMs\":1000},\"experiments\":[]}}";
        public int PostCount;
        public int CloseCount;

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            PostCount++;
            LastJson = Encoding.UTF8.GetString(Gunzip(gzippedBody));
            return Task.FromResult(new SyncResult(true, 200, Response));
        }

        public void Close() { CloseCount++; }

        static byte[] Gunzip(byte[] gzipped)
        {
            using (var input = new MemoryStream(gzipped))
            using (var gzip = new GZipStream(input, CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                gzip.CopyTo(output);
                return output.ToArray();
            }
        }
    }

    sealed class CancellationThenSuccessTransport : ISyncTransport
    {
        public int PostCount;
        public int CloseCount;
        public string FinalJson;

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            PostCount++;
            if (PostCount == 1)
            {
                var pending = new TaskCompletionSource<SyncResult>(TaskCreationOptions.RunContinuationsAsynchronously);
                cancellationToken.Register(() => pending.TrySetCanceled(cancellationToken));
                return pending.Task;
            }
            using (var input = new MemoryStream(gzippedBody))
            using (var gzip = new GZipStream(input, CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                gzip.CopyTo(output);
                FinalJson = Encoding.UTF8.GetString(output.ToArray());
            }
            return Task.FromResult(new SyncResult(true, 200, "{\"ok\":true,\"configVersion\":0}"));
        }

        public void Close() { CloseCount++; }
    }

    sealed class TimeoutTransport : ISyncTransport
    {
        public int CloseCount;

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            var pending = new TaskCompletionSource<SyncResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            cancellationToken.Register(() => pending.TrySetCanceled(cancellationToken));
            return pending.Task;
        }

        public void Close() { CloseCount++; }
    }

    static class SyncTests
    {
        enum DisabledName { Value }

        static void DisabledClient()
        {
            var options = new WardxOptions { Enabled = false };
            var transport = new MemoryTransport();
            var client = WardxClient.Create(options, transport);
            AssertX.True(client.Core == null, "disabled client has no telemetry engine");
            var counter = client.Counter("requests");
            var gauge = client.Gauge("load");
            var histogram = client.Histogram("latency");
            var distinct = client.Distinct("users");
            var timer = client.Timer("duration");
            options.Enabled = true;
            var fallback = new object();
            for (var i = 0; i < 2; i++)
            {
                counter.Inc();
                counter.Add(3);
                gauge.Set(5);
                histogram.Observe(12);
                distinct.Add(null);
                timer.Stop();
                client.Event("event");
                client.Identify(null);
                client.RetentionActivity(null);
                client.Log.Debug("debug");
                client.Log.Info("info");
                client.Log.Warn("warn");
                client.Log.Error("error");
                client.Experiment.Goal("goal");
                AssertX.True(ReferenceEquals(fallback, client.Config.Get("key", fallback)), "returns caller fallback");
                var name = (DisabledName)123;
                client.Counter(name).Inc();
                client.Gauge(name).Set(1);
                client.Histogram(name).Observe(1);
                client.Distinct(name).Add(null);
                client.Timer(name).Stop();
                client.Event(name);
                client.Log.Debug(name);
                client.Log.Info(name);
                client.Log.Warn(name);
                client.Log.Error(name);
                client.Experiment.Goal(name);
                AssertX.Equal(7, client.Config.Get(name, 7), "enum config fallback");
                client.AggregateTick();
                AssertX.True(client.FlushAsync().IsCompletedSuccessfully, "disabled flush completes immediately");
                AssertX.True(client.ShutdownAsync().IsCompletedSuccessfully, "disabled shutdown completes immediately");
                client.Stop();
                client.Dispose();
            }
            AssertX.Equal(0, transport.PostCount, "disabled custom transport unused");
            AssertX.Equal(0, transport.CloseCount, "disabled custom transport not owned");
            using (var automatic = WardxClient.Create(new WardxOptions { Enabled = false }))
            {
                AssertX.True(automatic.Core == null, "disabled default factory skips bootstrap");
                AssertX.True(automatic.FlushAsync().IsCompletedSuccessfully, "default disabled flush");
            }
            AssertX.Throws(() => WardxClient.Create(new WardxOptions()), "missing required keys");
        }

        public static void Run()
        {
            DisabledClient();
            var transport = new MemoryTransport();
            var client = WardxClient.Create(new WardxOptions
            {
                Endpoint = "http://127.0.0.1:9",
                ProjectKey = "test-key",
                Project = "demo",
                Role = "unity",
                AppVersion = "1.0.0",
                Environment = "test",
                PrivacySalt = "test-salt"
            }, transport);
            client.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
            client.FlushAsync().GetAwaiter().GetResult();
            AssertX.True(transport.LastJson != null, "sent json");
            var envelope = Json.Parse(transport.LastJson);
            AssertX.Equal(1.0, envelope["protocol"].NumberValue, "protocol");
            AssertX.Equal("demo", envelope["project"].StringValue, "project");
            AssertX.Equal("wardx-csharp", envelope["sdk"]["name"].StringValue, "sdk name");
            AssertX.Equal("unity", envelope["client"]["role"].StringValue, "role");
            AssertX.Equal("csharp", envelope["client"]["platform"].StringValue, "platform");
            AssertX.True(envelope["client"]["instanceId"].StringValue.Length == 26, "instance ulid");
            AssertX.True(envelope["frames"].ArrayValue.Count >= 1, "has frame");
            AssertX.Equal(1000, client.Config.Get("message.delayMs", 7), "applied config");
            client.Stop();

            var cancellationTransport = new CancellationThenSuccessTransport();
            var cancellationClient = WardxClient.Create(Options(40), cancellationTransport);
            cancellationClient.Counter("first").Inc();
            var inFlight = cancellationClient.FlushAsync();
            AssertX.Equal(1, cancellationTransport.PostCount, "first sync is in flight");
            cancellationClient.Event("pending-at-shutdown");
            var shutdownA = cancellationClient.ShutdownAsync();
            var shutdownB = cancellationClient.ShutdownAsync();
            AssertX.True(object.ReferenceEquals(shutdownA, shutdownB), "concurrent shutdown is idempotent");
            Task.WhenAll(inFlight, shutdownA, shutdownB).GetAwaiter().GetResult();
            AssertX.Equal(2, cancellationTransport.PostCount, "final flush uses an independent token");
            AssertX.Equal(1, cancellationTransport.CloseCount, "transport closes once after flush");
            AssertX.True(cancellationTransport.FinalJson.IndexOf("pending-at-shutdown", StringComparison.Ordinal) >= 0, "final flush sends pending frame");
            AssertX.True(
                cancellationTransport.FinalJson.IndexOf("wardx.internal.frames_failed", StringComparison.Ordinal) >= 0,
                "cancellation failure metric is observable on final flush"
            );
            AssertX.True(
                cancellationTransport.FinalJson.IndexOf("\"first\"", StringComparison.Ordinal) < 0,
                "failed frame is not re-enqueued"
            );

            var timeoutTransport = new TimeoutTransport();
            var timeoutClient = WardxClient.Create(Options(30), timeoutTransport);
            timeoutClient.Event("will-time-out");
            var started = System.Diagnostics.Stopwatch.StartNew();
            timeoutClient.ShutdownAsync().GetAwaiter().GetResult();
            started.Stop();
            AssertX.True(started.ElapsedMilliseconds < 1000, "shutdown timeout is bounded");
            AssertX.True(timeoutClient.Core.Internal.FramesFailed >= 1, "shutdown timeout increments failure metric");
            AssertX.Equal(1, timeoutTransport.CloseCount, "timed out transport closes once");

            RunRealHttpShutdown();
        }

        static WardxOptions Options(int httpTimeoutMs)
        {
            return new WardxOptions
            {
                Endpoint = "http://127.0.0.1:9",
                ProjectKey = "test-key",
                Project = "demo",
                Role = "unity",
                AppVersion = "1.0.0",
                Environment = "test",
                PrivacySalt = "test-salt",
                HttpTimeoutMs = httpTimeoutMs
            };
        }

        static void RunRealHttpShutdown()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();

            using (var listener = new HttpListener())
            {
                listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
                listener.Start();
                var received = Task.Run(async () =>
                {
                    var context = await listener.GetContextAsync().ConfigureAwait(false);
                    using (var body = new MemoryStream())
                    {
                        await context.Request.InputStream.CopyToAsync(body).ConfigureAwait(false);
                    }
                    var response = Encoding.UTF8.GetBytes("{\"ok\":true,\"configVersion\":0}");
                    context.Response.StatusCode = 200;
                    context.Response.ContentType = "application/json";
                    context.Response.ContentLength64 = response.Length;
                    await context.Response.OutputStream.WriteAsync(response, 0, response.Length).ConfigureAwait(false);
                    context.Response.Close();
                    return true;
                });
                var options = Options(1000);
                options.Endpoint = "http://127.0.0.1:" + port;
                var client = WardxClient.Create(
                    options,
                    new HttpClientTransport(options.Endpoint, options.ProjectKey, options.HttpTimeoutMs.Value)
                );
                client.Event("real-http-shutdown");
                client.ShutdownAsync().GetAwaiter().GetResult();
                AssertX.True(received.GetAwaiter().GetResult(), "real HTTP server received shutdown frame");
            }
        }
    }

    static class JsonTests
    {
        public static void Run()
        {
            var json = Json.Stringify(new System.Collections.Generic.Dictionary<string, object>
            {
                ["a"] = 1,
                ["b"] = "x",
                ["c"] = null,
                ["d"] = true
            });
            AssertX.Equal("{\"a\":1,\"b\":\"x\",\"c\":null,\"d\":true}", json, "stringify");
            var parsed = Json.Parse("{\"ok\":true,\"configVersion\":12,\"n\":1.5}");
            AssertX.True(parsed["ok"].BoolValue, "ok");
            AssertX.Equal(12.0, parsed["configVersion"].NumberValue, "version");
            AssertX.Equal(1.5, parsed["n"].NumberValue, "float");
        }
    }
}
