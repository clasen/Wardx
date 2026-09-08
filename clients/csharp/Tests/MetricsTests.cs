using System.Threading;

namespace Wardx.Tests
{
    static class MetricsTests
    {
        public static void Run()
        {
            var metrics = Registry();
            var c = metrics.Counter("match.completed");
            c.Inc();
            c.Inc();
            metrics.Counter("coins.spent").Add(50);
            var snap = metrics.SnapshotAndReset();
            AssertX.Equal(2, snap.Counters.Count, "two counters");
            AssertX.Equal("match.completed", snap.Counters[0].Name, "first name");
            AssertX.Equal(2.0, snap.Counters[0].Value, "inc twice");
            AssertX.Equal(50.0, snap.Counters[1].Value, "add 50");
            AssertX.Equal(0.0, ((Counter)metrics.Counter("match.completed")).Value, "reset");

            var metrics2 = Registry();
            metrics2.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
            metrics2.Counter("match.completed", Dims.Of("mode", "casual")).Add(3);
            var snap2 = metrics2.SnapshotAndReset();
            AssertX.Equal(2, snap2.Counters.Count, "two series");

            var dropped = 0;
            var metrics3 = Registry(2, () => dropped++);
            metrics3.Counter("q", Dims.Of("n", 1)).Inc();
            metrics3.Counter("q", Dims.Of("n", 2)).Inc();
            metrics3.Counter("q", Dims.Of("n", 3)).Inc();
            metrics3.Counter("q", Dims.Of("n", 3)).Inc();
            AssertX.Equal(2, metrics3.SnapshotAndReset().Counters.Count, "cap 2");
            AssertX.Equal(1, dropped, "one drop");

            var dropped2 = 0;
            var limited = new MetricsRegistry(1000, 1, 4, new double[] { 10, 25 }, () => dropped2++);
            limited.Counter("q", Dims.Of("a", 1, "b", 2)).Inc();
            limited.Counter("q", Dims.Of("a", "too-long")).Inc();
            limited.Counter("q", Dims.Of("a", "ok")).Inc();
            AssertX.Equal(1, limited.SnapshotAndReset().Counters.Count, "one valid");
            AssertX.Equal(2, dropped2, "two rejects");

            var gauges = Registry();
            gauges.Gauge("players.online").Set(12492);
            var gsnap = gauges.SnapshotAndReset();
            AssertX.Equal(1, gsnap.Gauges.Count, "one gauge");
            AssertX.Equal(12492.0, gsnap.Gauges[0].Value, "gauge value");

            var histReg = Registry();
            var hh = histReg.Histogram("request.duration", null, new double[] { 10, 25, 50 });
            hh.Observe(3);
            hh.Observe(12);
            hh.Observe(80);
            var hbody = histReg.SnapshotAndReset().Histograms[0].Body;
            AssertX.Equal(3, hbody.Count, "count");
            AssertX.Equal(95.0, hbody.Sum, "sum");
            AssertX.Equal(3.0, hbody.Min, "min");
            AssertX.Equal(80.0, hbody.Max, "max");
            AssertX.Equal(1, hbody.Buckets[0].Count, "le 10");
            AssertX.Equal(1, hbody.Buckets[1].Count, "le 25");
            AssertX.Equal(0, hbody.Buckets[2].Count, "le 50");
            AssertX.True(hbody.Exemplar == null, "no exemplar");

            var ex = Registry();
            var hx = ex.Histogram("coins.award_size", null, new double[] { 10, 50, 100 });
            hx.Observe(12, Dims.Of("grantId", "g-small"));
            hx.Observe(80, Dims.Of("grantId", "g-max"));
            hx.Observe(40, Dims.Of("grantId", "g-mid"));
            var ebody = ex.SnapshotAndReset().Histograms[0].Body;
            AssertX.Equal(80.0, ebody.Max, "max 80");
            AssertX.Equal(80.0, ebody.Exemplar.Value, "exemplar value");
            AssertX.Equal("g-max", (string)ebody.Exemplar.Attrs["grantId"], "exemplar grant");

            var token = Registry();
            var end = token.Timer("matchmaking.duration");
            Thread.Sleep(12);
            end.Stop();
            var tsnap = token.SnapshotAndReset();
            AssertX.Equal(1, tsnap.Histograms.Count, "timer histogram");
            AssertX.True(tsnap.Histograms[0].Body.Min >= 1, "timer min ms");

            var distincts = Registry(1000, null, "test-salt");
            var distinct = distincts.Distinct("shot.traffic.hids", Dims.Of("result", "violating"));
            distinct.Add("hid-a");
            distinct.Add("hid-a");
            distinct.Add("hid-b");
            var distinctSnapshot = distincts.SnapshotAndReset();
            AssertX.Equal(1, distinctSnapshot.Distincts.Count, "one distinct sketch");
            var registers = System.Convert.FromBase64String(distinctSnapshot.Distincts[0].Body.Registers);
            AssertX.Equal((byte)3, registers[386], "shared Node/C# register 386");
            AssertX.Equal((byte)2, registers[418], "shared Node/C# register 418");
            AssertX.Equal(0, distincts.SnapshotAndReset().Distincts.Count, "distinct reset");
        }

        static MetricsRegistry Registry(int maxSeries = 1000, System.Action onDrop = null, string privacySalt = "test-salt")
        {
            return new MetricsRegistry(
                maxSeries,
                8,
                64,
                new double[] { 10, 25, 50, 100 },
                onDrop ?? (() => { }),
                privacySalt
            );
        }
    }
}
