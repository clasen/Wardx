using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Wardx.Tests
{
    sealed class SwitchableTransport : ISyncTransport
    {
        public readonly List<string> Jsons = new List<string>();
        public readonly List<string> Delivered = new List<string>();
        public bool Fail;
        public Func<string, int> StatusFor = json => 200;

        public Task<SyncResult> PostAsync(byte[] gzippedBody, CancellationToken cancellationToken)
        {
            string json;
            using (var input = new MemoryStream(gzippedBody))
            using (var gzip = new GZipStream(input, CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                gzip.CopyTo(output);
                json = Encoding.UTF8.GetString(output.ToArray());
            }
            Jsons.Add(json);
            var status = Fail ? 503 : StatusFor(json);
            if (status != 200) return Task.FromResult(new SyncResult(false, status, null));
            Delivered.Add(json);
            return Task.FromResult(new SyncResult(true, 200, ServerResponses.Stamp("{\"ok\":true,\"configVersion\":0}")));
        }

        public void Close() { }
    }

    static class RetainedTests
    {
        public static void Run()
        {
            FailedSyncKeepsValuesUntilDelivered();
            TransientRejectionRetriesFlight();
            PermanentRejectionDropsOnlyTheFlight();
            ValuesSurviveRestart();
            UnacknowledgedFlightIsResent();
            DistinctsMergeAcrossRestart();
            SeriesCapBoundsRetainedState();
            WritesAreBatched();
            CorruptFileStartsEmpty();
            RequiresRetainedPath();
        }

        static void FailedSyncKeepsValuesUntilDelivered()
        {
            var path = TempPath();
            var transport = new SwitchableTransport();
            var client = WardxClient.Create(Options(path), transport);
            try
            {
                Wait(client.FlushAsync());
                var played = client.RetainedCounter("offline.matches", Dims.Of("mode", "solo"));
                played.Inc();
                played.Add(2);
                transport.Fail = true;
                Wait(client.FlushAsync());
                AssertX.Equal(0.0, DeliveredTotal(transport, "offline.matches"), "nothing is delivered while offline");
                transport.Fail = false;
                Wait(client.FlushAsync());
                AssertX.Equal(3.0, DeliveredTotal(transport, "offline.matches"), "values are delivered once back online");
                Wait(client.FlushAsync());
                AssertX.Equal(3.0, DeliveredTotal(transport, "offline.matches"), "delivered values are not re-sent");
            }
            finally
            {
                Wait(client.ShutdownAsync());
                Delete(path);
            }
        }

        static void TransientRejectionRetriesFlight()
        {
            var path = TempPath();
            var transport = new SwitchableTransport();
            var client = WardxClient.Create(Options(path), transport);
            try
            {
                Wait(client.FlushAsync());
                client.RetainedCounter("offline.matches").Add(4);
                transport.StatusFor = json => json.Contains("offline.matches") ? 503 : 200;
                Wait(client.FlushAsync());
                transport.StatusFor = json => 200;
                Wait(client.FlushAsync());
                AssertX.Equal(4.0, DeliveredTotal(transport, "offline.matches"), "a 503 keeps the flight for the next sync");
            }
            finally
            {
                Wait(client.ShutdownAsync());
                Delete(path);
            }
        }

        static void PermanentRejectionDropsOnlyTheFlight()
        {
            var path = TempPath();
            var transport = new SwitchableTransport();
            var client = WardxClient.Create(Options(path), transport);
            try
            {
                Wait(client.FlushAsync());
                client.Counter("regular").Inc();
                client.RetainedCounter("offline.matches").Add(4);
                transport.StatusFor = json => json.Contains("offline.matches") ? 400 : 200;
                Wait(client.FlushAsync());
                AssertX.Equal(1.0, DeliveredTotal(transport, "regular"), "regular frames travel in their own envelope");
                transport.StatusFor = json => 200;
                Wait(client.FlushAsync());
                Wait(client.FlushAsync());
                AssertX.Equal(0.0, DeliveredTotal(transport, "offline.matches"), "a 400 drops the flight instead of retrying it");
            }
            finally
            {
                Wait(client.ShutdownAsync());
                Delete(path);
            }
        }

        static void ValuesSurviveRestart()
        {
            var path = TempPath();
            try
            {
                var offline = new SwitchableTransport { Fail = true };
                var first = WardxClient.Create(Options(path), offline);
                first.RetainedCounter("offline.seconds").Add(40);
                Wait(first.FlushAsync());
                first.Stop();

                var online = new SwitchableTransport();
                var second = WardxClient.Create(Options(path), online);
                second.RetainedCounter("offline.seconds").Add(2);
                Wait(second.FlushAsync());
                Wait(second.ShutdownAsync());
                AssertX.Equal(42.0, DeliveredTotal(online, "offline.seconds"), "values from the previous process are delivered once");
                AssertX.True(!File.ReadAllText(path).Contains("offline.seconds"), "delivered values leave the file");
            }
            finally { Delete(path); }
        }

        static void UnacknowledgedFlightIsResent()
        {
            var path = TempPath();
            try
            {
                var settings = Fixtures.TestSettings(options => options.RetainedPath = path);
                var crashed = new RetainedMetrics(settings, () => { });
                crashed.Counter("offline.matches", null).Add(5);
                AssertX.True(crashed.BeginFlight() != null, "flight opens with pending values");

                var restarted = new RetainedMetrics(settings, () => { });
                var flight = restarted.BeginFlight();
                AssertX.Equal(1, flight.Counters.Count, "flight row restored");
                AssertX.Equal(5.0, flight.Counters[0].Value, "unacknowledged flight returns to pending");
            }
            finally { Delete(path); }
        }

        static void DistinctsMergeAcrossRestart()
        {
            var path = TempPath();
            try
            {
                var settings = Fixtures.TestSettings(options => options.RetainedPath = path);
                var first = new RetainedMetrics(settings, () => { });
                first.Distinct("offline.users", null).Add("ana");
                first.Distinct("offline.users", null).Add("beto");
                first.SaveIfDirty();
                var second = new RetainedMetrics(settings, () => { });
                second.Distinct("offline.users", null).Add("ana");
                second.Distinct("offline.users", null).Add("caro");

                var expected = new HyperLogLog("offline.users", null, settings.PrivacySalt);
                foreach (var user in new[] { "ana", "beto", "caro" }) expected.Add(user);
                var flight = second.BeginFlight();
                AssertX.Equal(expected.Snapshot().Registers, flight.Distincts[0].Body.Registers, "registers are the union of both processes");
            }
            finally { Delete(path); }
        }

        static void SeriesCapBoundsRetainedState()
        {
            var path = TempPath();
            try
            {
                var dropped = 0;
                var wide = Fixtures.TestSettings(options => options.RetainedPath = path);
                var first = new RetainedMetrics(wide, () => { });
                foreach (var mode in new[] { "a", "b", "c" }) first.Counter("offline.matches", Dims.Of("mode", mode)).Inc();
                first.SaveIfDirty();

                var narrow = Fixtures.TestSettings(options =>
                {
                    options.RetainedPath = path;
                    options.MaxRetainedSeries = 2;
                });
                var restored = new RetainedMetrics(narrow, () => dropped++);
                AssertX.Equal(1, dropped, "series beyond the cap are not restored");
                var extra = restored.Counter("offline.seconds", null);
                extra.Add(9);
                AssertX.Equal(2, dropped, "new series beyond the cap are rejected");
                var flight = restored.BeginFlight();
                AssertX.Equal(2, flight.Counters.Count, "flight holds at most maxRetainedSeries rows");
                AssertX.Throws(() => Fixtures.TestSettings(options => options.MaxRetainedSeries = 0), "maxRetainedSeries must be a finite number > 0");
            }
            finally { Delete(path); }
        }

        static void WritesAreBatched()
        {
            var path = TempPath();
            var client = WardxClient.Create(Options(path), new SwitchableTransport { Fail = true });
            try
            {
                var seconds = client.RetainedCounter("offline.seconds");
                for (var i = 0; i < 100; i++) seconds.Inc();
                AssertX.True(!File.Exists(path), "mutations do not write to disk");
                Wait(client.EnqueueSnapshot());
                AssertX.True(File.ReadAllText(path).Contains("[\"offline.seconds\",null,100]"), "the aggregate tick writes the state once");
                seconds.Inc();
                client.Stop();
                AssertX.True(File.ReadAllText(path).Contains("[\"offline.seconds\",null,101]"), "stop writes pending changes");
            }
            finally
            {
                client.Stop();
                Delete(path);
            }
        }

        static void CorruptFileStartsEmpty()
        {
            var path = TempPath();
            try
            {
                File.WriteAllText(path, "{\"version\":1,\"pending\":{\"counters\":[[\"x\",null]]}}");
                var settings = Fixtures.TestSettings(options => options.RetainedPath = path);
                var retained = new RetainedMetrics(settings, () => { });
                AssertX.True(retained.BeginFlight() == null, "corrupt state is discarded");
                retained.Counter("offline.matches", null).Inc();
                AssertX.Equal(1.0, retained.BeginFlight().Counters[0].Value, "new values are retained after discarding");
            }
            finally { Delete(path); }
        }

        static void RequiresRetainedPath()
        {
            var client = WardxClient.Create(Options(null), new SwitchableTransport());
            try
            {
                AssertX.Throws(() => client.RetainedCounter("offline.matches"), "retained metrics require retainedPath");
            }
            finally { client.Stop(); }
            AssertX.Throws(() => Fixtures.TestSettings(options => options.RetainedPath = ""), "retainedPath must be a non-empty string");
        }

        static double DeliveredTotal(SwitchableTransport transport, string name)
        {
            var total = 0.0;
            foreach (var json in transport.Delivered)
            {
                foreach (var frame in Json.Parse(json)["frames"].ArrayValue)
                {
                    foreach (var row in frame["metrics"]["counters"].ArrayValue)
                    {
                        if (row.ArrayValue[0].StringValue == name) total += row.ArrayValue[2].NumberValue;
                    }
                }
            }
            return total;
        }

        static WardxOptions Options(string path)
        {
            return new WardxOptions
            {
                Endpoint = "http://127.0.0.1:9",
                ProjectKey = "test-key",
                Project = "demo",
                Role = "unity",
                AppVersion = "0.0.0",
                Environment = "test",
                PrivacySalt = "test-salt",
                AggregateIntervalMs = 60_000,
                SyncIntervalMs = 60_000,
                RetainedPath = path
            };
        }

        static string TempPath()
        {
            return Path.Combine(Path.GetTempPath(), "wardx-retained-" + Guid.NewGuid().ToString("N") + ".json");
        }

        static void Delete(string path)
        {
            File.Delete(path);
            File.Delete(path + ".tmp");
        }

        static void Wait(Task task)
        {
            AssertX.True(Task.WhenAny(task, Task.Delay(5000)).GetAwaiter().GetResult() == task, "operation completes within test deadline");
            task.GetAwaiter().GetResult();
        }
    }
}
