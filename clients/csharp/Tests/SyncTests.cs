using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Wardx.Tests
{
    sealed class MemoryTransport : ISyncTransport
    {
        public string LastJson;
        public string Response = "{\"ok\":true,\"serverTime\":1,\"configVersion\":13,\"config\":{\"values\":{\"message.delayMs\":1000},\"experiments\":[]}}";

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            LastJson = Encoding.UTF8.GetString(Gunzip(gzippedBody));
            return Task.FromResult(new SyncResult(true, 200, Response));
        }

        public void Close() { }

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

    static class SyncTests
    {
        public static void Run()
        {
            var transport = new MemoryTransport();
            var client = WardxClient.Create(new WardxOptions
            {
                Endpoint = "http://127.0.0.1:9",
                ProjectKey = "test-key",
                Project = "demo",
                Role = "unity",
                AppVersion = "1.0.0",
                Environment = "test"
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
