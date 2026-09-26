using System.Collections.Generic;
using System.Text;

namespace Wardx.Tests
{
    static class BufferTests
    {
        public static void Run()
        {
            var buf = new EventBuffer(2);
            AssertX.True(buf.Push("a", null), "push a");
            AssertX.True(buf.Push("b", null), "push b");
            AssertX.True(!buf.Push("c", null), "drop c");
            var sealedBuf = buf.Swap();
            AssertX.Equal(2, sealedBuf.Count, "sealed 2");
            AssertX.Equal(0, buf.Length, "empty after swap");

            var logs = new LogBuffer(2);
            AssertX.True(logs.Push("debug", "d1", null), "debug");
            AssertX.True(logs.Push("info", "i1", null), "info");
            AssertX.True(!logs.Push("error", "e1", null), "replace returns false");
            var messages = new List<string>();
            foreach (var row in logs.Swap()) messages.Add(row.Message);
            messages.Sort();
            AssertX.Equal("e1", messages[0], "kept error");
            AssertX.Equal("i1", messages[1], "kept info");

            var errors = new LogBuffer(1);
            AssertX.True(errors.Push("error", "e1", null), "error in");
            AssertX.True(!errors.Push("debug", "d1", null), "debug dropped");
            AssertX.Equal("e1", errors.Swap()[0].Message, "kept error");
        }
    }

    static class FrameTests
    {
        public static void Run()
        {
            LinearSerialization();
            Utf8Boundaries();
            var bounded = new WardxCore(Fixtures.TestSettings(o => o.MaxPendingFrames = 3));
            for (var i = 0; i < 100; i++)
            {
                bounded.Event("event." + i);
                bounded.SnapshotFrame();
                AssertX.Equal(i >= 3 ? 1.0 : 0.0, bounded.Internal.FramesFailed, "overflow counted each window");
            }
            var pending = bounded.TakePendingFrames();
            AssertX.Equal(3, pending.Count, "pending capacity");
            for (var i = 0; i < pending.Count; i++)
            {
                AssertX.Equal(98 + i, pending[i].Seq, "recent sequence retained");
                AssertX.Equal("event." + (97 + i), pending[i].Events[0].Name, "recent event retained");
            }
            AssertX.Equal(0, bounded.TakePendingFrames().Count, "drains once");
            bounded.Event("recovered");
            bounded.SnapshotFrame();
            var recovered = bounded.TakePendingFrames();
            AssertX.Equal(101, recovered[0].Seq, "sequence after recovery");
            AssertX.True(recovered[0].Counters.Exists(row => row.Name == Protocol.Internal.FramesFailed && row.Value == 1), "overflow reported after recovery");

            var splitBounded = new WardxCore(Fixtures.TestSettings(o =>
            {
                o.MaxPendingFrames = 2;
                o.MaxFrameBytes = 1024;
            }));
            splitBounded.Event("old");
            splitBounded.SnapshotFrame();
            for (var i = 0; i < 100; i++) splitBounded.Event("event." + i, Dims.Of("pad", new string('x', 100)));
            var oversized = splitBounded.SnapshotFrame();
            AssertX.True(oversized.Frames.Count > 2, "batch exceeds pending capacity");
            var retained = splitBounded.TakePendingFrames();
            AssertX.Equal(2, retained.Count, "split batch capacity");
            AssertX.True(ReferenceEquals(oversized.Frames[oversized.Frames.Count - 2], retained[0]), "recent split frame retained");
            AssertX.True(ReferenceEquals(oversized.Frames[oversized.Frames.Count - 1], retained[1]), "final split frame retained");
            AssertX.Equal((double)(1 + oversized.Frames.Count - 2), splitBounded.Internal.FramesFailed, "all evictions counted");

            var core = new WardxCore(Fixtures.TestSettings(o => o.MaxBufferedEvents = 10));
            core.Counter("n").Add(4);
            core.Event("a", Dims.Of("k", 1));
            var first = core.SnapshotFrame();
            core.Event("b", Dims.Of("k", 2));
            var second = core.SnapshotFrame();
            AssertX.Equal(1, AllEvents(first).Count, "first events");
            AssertX.Equal("a", AllEvents(first)[0].Name, "event a");
            AssertX.Equal(1, AllEvents(second).Count, "second events");
            AssertX.Equal("b", AllEvents(second)[0].Name, "event b");
            var found = false;
            foreach (var row in AllCounters(first))
            {
                if (row.Name == "n")
                {
                    found = true;
                    AssertX.Equal(4.0, row.Value, "counter 4");
                }
            }
            AssertX.True(found, "counter n present");
            AssertX.Equal(first.Frames[first.Frames.Count - 1].Seq + 1, second.Frames[0].Seq, "seq");

            var retention = new WardxCore(Fixtures.TestSettings());
            retention.Identify("implicit-user");
            foreach (var invalid in new string[] { null, "", "  " })
                AssertX.Throws(() => retention.RetentionActivity(invalid), "non-empty userId");
            retention.RetentionActivity("private-user");
            retention.RetentionActivity("private-user");
            var activity = AllEvents(retention.SnapshotFrame());
            AssertX.Equal(2, activity.Count, "retention activity count");
            AssertX.Equal("retention.activity", activity[0].Name);
            AssertX.Equal(Hash.SubjectHash("test-salt", "private-user"), (string)activity[0].Attrs["subject"]);
            AssertX.Equal(Hash.SubjectHash("test-salt", "wardx.retention.identity"), (string)activity[0].Attrs["salt"]);
            AssertX.Equal((string)activity[0].Attrs["subject"], (string)activity[1].Attrs["subject"]);

            var core2 = new WardxCore(Fixtures.TestSettings(o => o.MaxBufferedEvents = 1));
            core2.Event("keep");
            core2.Event("drop-me");
            var fitted = core2.SnapshotFrame();
            var dropped = 0.0;
            foreach (var row in AllCounters(fitted))
            {
                if (row.Name == Protocol.Internal.EventsDropped) dropped = row.Value;
            }
            AssertX.Equal(1.0, dropped, "events_dropped");

            var distinctCore = new WardxCore(Fixtures.TestSettings(o => o.MaxFrameBytes = 1024));
            distinctCore.Distinct("shot.traffic.hids", Dims.Of("result", "violating")).Add("private-hid");
            var distinctBatch = distinctCore.SnapshotFrame();
            AssertX.Equal(0, distinctBatch.DroppedDistincts, "HLL fits minimum frame");
            var distinctRows = 0;
            foreach (var physical in distinctBatch.Frames) distinctRows += physical.Distincts.Count;
            AssertX.Equal(1, distinctRows, "one HLL row");
            AssertX.True(
                string.Join("", distinctBatch.Jsons).IndexOf("private-hid", System.StringComparison.Ordinal) < 0,
                "raw HID absent"
            );
            AssertConsecutiveAndBounded(distinctBatch, 1024);

            var events = new List<EventSample>();
            for (var i = 0; i < 200; i++)
            {
                events.Add(new EventSample(i, "e", Dims.Of("pad", new string('y', 80))));
            }
            var frame = Bare(events, new List<LogSample>());
            var split = FrameBuilder.SplitToMaxBytes(frame, 4096);
            AssertX.True(split.Frames.Count > 1, "events split");
            AssertX.Equal(0, split.DroppedRows, "no event loss");
            AssertX.Equal(200, AllEvents(split).Count, "all events preserved");
            AssertX.Equal(0L, AllEvents(split)[0].Time, "prefix preserved");
            AssertConsecutiveAndBounded(split, 4096);

            var logs = new List<LogSample>
            {
                new LogSample(1, "error", "keep-error", Dims.Of("pad", new string('x', 40))),
                new LogSample(2, "debug", "drop-debug", Dims.Of("pad", new string('x', 40))),
                new LogSample(3, "error", "keep-error-2", Dims.Of("pad", new string('x', 40)))
            };
            var logFrame = Bare(new List<EventSample>(), logs);
            var logSplit = FrameBuilder.SplitToMaxBytes(logFrame, 1024);
            AssertX.Equal(0, logSplit.DroppedRows, "logs preserved");
            AssertX.Equal(3, AllLogs(logSplit).Count, "all logs kept");
            AssertConsecutiveAndBounded(logSplit, 1024);

            var indivisible = Bare(new List<EventSample>(), new List<LogSample>());
            indivisible.Counters.Add(new CounterSample(new string('x', 3000), null, 1));
            indivisible.Counters.Add(new CounterSample("kept", null, 2));
            var droppedBatch = FrameBuilder.SplitToMaxBytes(indivisible, 1024);
            AssertX.Equal(1, droppedBatch.DroppedRows, "one indivisible row dropped");
            AssertX.Equal(1, droppedBatch.DroppedCounters, "counter drop classified");
            var sawDropMetric = false;
            var sawKept = false;
            foreach (var row in AllCounters(droppedBatch))
            {
                if (row.Name == Protocol.Internal.FrameRowsDropped && row.Value == 1) sawDropMetric = true;
                if (row.Name == "kept" && row.Value == 2) sawKept = true;
            }
            AssertX.True(sawDropMetric, "drop is observable in-band");
            AssertX.True(sawKept, "splittable counter remains");
            AssertConsecutiveAndBounded(droppedBatch, 1024);

            var mixedCore = new WardxCore(Fixtures.TestSettings(o =>
            {
                o.MaxFrameBytes = 1024;
                o.MaxSeriesPerMetric = 500;
            }));
            for (var i = 0; i < 150; i++) mixedCore.Counter("counter." + i, Dims.Of("lane", i)).Inc();
            for (var i = 0; i < 40; i++)
            {
                mixedCore.Gauge("gauge." + i).Set(i);
                mixedCore.Event("event." + i, Dims.Of("value", i));
                mixedCore.Log.Info("log-" + i, Dims.Of("value", i));
            }
            var mixed = mixedCore.SnapshotFrame();
            AssertX.True(mixed.Frames.Count > 1, "mixed snapshot split");
            AssertX.Equal(0, mixed.DroppedRows, "mixed snapshot lossless");
            AssertConsecutiveAndBounded(mixed, 1024);

            AssertX.Throws(
                () => FrameBuilder.SplitToMaxBytes(Bare(new List<EventSample>(), new List<LogSample>()), 1023),
                "at least 1024"
            );

            var sharedFixture = Bare(
                new List<EventSample>
                {
                    new EventSample(1, "fixture.event", Dims.Of("runtime", "shared"))
                },
                new List<LogSample>()
            );
            sharedFixture.Seq = 7;
            for (var i = 0; i < 80; i++)
            {
                sharedFixture.Counters.Add(new CounterSample("counter." + i, null, i));
            }
            var shared = FrameBuilder.SplitToMaxBytes(sharedFixture, 1024);
            AssertX.Equal(3, shared.Frames.Count, "shared fixture frame count");
            AssertX.Equal(7, shared.Frames[0].Seq, "shared fixture seq 1");
            AssertX.Equal(8, shared.Frames[1].Seq, "shared fixture seq 2");
            AssertX.Equal(9, shared.Frames[2].Seq, "shared fixture seq 3");
            AssertX.Equal(41, shared.Frames[0].Counters.Count, "shared fixture counters 1");
            AssertX.Equal(39, shared.Frames[1].Counters.Count, "shared fixture counters 2");
            AssertX.Equal(0, shared.Frames[2].Counters.Count, "shared fixture counters 3");
            AssertX.Equal(1, shared.Frames[2].Events.Count, "shared fixture final event");
            AssertX.Equal(1023, Encoding.UTF8.GetByteCount(shared.Jsons[0]), "shared fixture bytes 1");
            AssertX.Equal(997, Encoding.UTF8.GetByteCount(shared.Jsons[1]), "shared fixture bytes 2");
            AssertX.Equal(141, Encoding.UTF8.GetByteCount(shared.Jsons[2]), "shared fixture bytes 3");
        }

        static void LinearSerialization()
        {
            foreach (var count in new[] { 100, 1000, 10000 })
            {
                var dims = new ObservedDimensions();
                var frame = Bare(new List<EventSample>(), new List<LogSample>());
                for (var i = 0; i < count; i++) frame.Counters.Add(new CounterSample("series." + i, dims, i));
                var allocatedBefore = System.GC.GetAllocatedBytesForCurrentThread();
                var watch = System.Diagnostics.Stopwatch.StartNew();
                var batch = FrameBuilder.SplitToMaxBytes(frame, 524288);
                watch.Stop();
                var allocated = System.GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
                AssertX.Equal(0, batch.DroppedRows, "many series stay lossless");
                AssertX.Equal(count, AllCounters(batch).Count, "all series retained");
                AssertX.True(dims.Enumerations <= count * 2, "row serialization work must stay linear");
                AssertConsecutiveAndBounded(batch, 524288);
                System.Console.WriteLine($"      split {count} series: {watch.Elapsed.TotalMilliseconds:F2} ms, {allocated} allocated bytes");
            }
        }

        static void Utf8Boundaries()
        {
            var frame = Bare(new List<EventSample>(), new List<LogSample>());
            frame.Seq = 9;
            frame.Counters.Add(new CounterSample("requests", null, 1));
            frame.Gauges.Add(new GaugeSample("温度", Dims.Of("city", "東京"), 21, 1));
            var histogram = new Histogram("latency", null, new double[] { 10 }, 8, 64);
            histogram.Observe(1, Dims.Of("text", "\"\\\n🧪"));
            frame.Histograms.Add(new HistogramSample("latency", null, histogram.Snapshot()));
            for (var i = 0; i < 30; i++)
                frame.Distincts.Add(new DistinctSample("users." + i, null, new HllBody(9, System.Convert.ToBase64String(new byte[512]))));
            for (var i = 0; i < 50; i++)
                frame.Events.Add(new EventSample(i, "🧪", Dims.Of("text", new string('á', 200) + "\"\\\n")));
            frame.Logs.Add(new LogSample(1, "info", "日本語", Dims.Of("text", "\ud800")));
            var batch = FrameBuilder.SplitToMaxBytes(frame, 1024);
            AssertX.Equal(0, batch.DroppedRows, "UTF-8 mixed rows retained");
            AssertX.Equal(10, batch.Frames[1].Seq, "sequence width changes");
            var distinctCount = 0;
            for (var i = 0; i < batch.Frames.Count; i++)
            {
                AssertX.Equal(9 + i, batch.Frames[i].Seq, "consecutive sequences");
                AssertX.Equal(Json.Stringify(batch.Frames[i].ToWire()), batch.Jsons[i], "JSON matches physical frame");
                AssertX.True(Encoding.UTF8.GetByteCount(batch.Jsons[i]) <= 1024, "UTF-8 frame limit");
                distinctCount += batch.Frames[i].Distincts.Count;
            }
            AssertX.Equal(30, distinctCount, "optional distinct rows retained");
            AssertX.Equal(50, AllEvents(batch).Count, "all unicode events retained");
            AssertX.Equal(1, AllLogs(batch).Count, "unicode log retained");

            var exact = Bare(new List<EventSample>(), new List<LogSample>());
            exact.Counters.Add(new CounterSample("exact", null, 1));
            var baseBytes = Encoding.UTF8.GetByteCount(FrameBuilder.SplitToMaxBytes(exact, 1024).Jsons[0]);
            exact.Counters[0] = new CounterSample("exact" + new string('x', 1024 - baseBytes), null, 1);
            exact.Distincts.Add(new DistinctSample("too-large", null, new HllBody(9, new string('x', 1024))));
            var fitted = FrameBuilder.SplitToMaxBytes(exact, 1024);
            AssertX.Equal(1024, Encoding.UTF8.GetByteCount(fitted.Jsons[0]), "exact byte fit accepted");
            AssertX.Equal(1, fitted.DroppedDistincts, "oversized distinct dropped");
            AssertX.True(AllCounters(fitted).Exists(row => row.Name == Protocol.Internal.FrameRowsDropped && row.Value == 1), "drop reported");
            foreach (var json in fitted.Jsons)
                AssertX.True(json.IndexOf("\"distincts\"", System.StringComparison.Ordinal) < 0, "no empty distinct property");
        }

        static List<CounterSample> AllCounters(FrameBatch batch)
        {
            var rows = new List<CounterSample>();
            foreach (var frame in batch.Frames) rows.AddRange(frame.Counters);
            return rows;
        }

        static List<EventSample> AllEvents(FrameBatch batch)
        {
            var rows = new List<EventSample>();
            foreach (var frame in batch.Frames) rows.AddRange(frame.Events);
            return rows;
        }

        static List<LogSample> AllLogs(FrameBatch batch)
        {
            var rows = new List<LogSample>();
            foreach (var frame in batch.Frames) rows.AddRange(frame.Logs);
            return rows;
        }

        static void AssertConsecutiveAndBounded(FrameBatch batch, int maxBytes)
        {
            for (var i = 0; i < batch.Frames.Count; i++)
            {
                AssertX.Equal(i + 1, batch.Frames[i].Seq, "consecutive seq");
                AssertX.True(Encoding.UTF8.GetByteCount(batch.Jsons[i]) <= maxBytes, "frame byte bound");
            }
        }

        static Frame Bare(List<EventSample> events, List<LogSample> logs)
        {
            return new Frame
            {
                Seq = 1,
                From = 1,
                To = 2,
                Events = events,
                Logs = logs
            };
        }
    }

    static class SettingsTests
    {
        public static void Run()
        {
            AssertX.Throws(() => Settings.Resolve(new WardxOptions()), "missing required keys");
            var baseOpts = new WardxOptions
            {
                Endpoint = "http://127.0.0.1:1",
                ProjectKey = "k",
                Project = "p",
                AppVersion = "1",
                Environment = "test",
                PrivacySalt = "test-salt"
            };
            baseOpts.Role = "";
            AssertX.Throws(() => Settings.Resolve(baseOpts), "role must be a non-empty string");
            baseOpts.Role = "*";
            AssertX.Throws(() => Settings.Resolve(baseOpts), "role cannot be *");
            baseOpts.Role = "unity";
            baseOpts.HistogramBuckets = new double[] { 10, 10 };
            AssertX.Throws(() => Settings.Resolve(baseOpts), "histogramBuckets");
            var ulid = Ids.Ulid();
            AssertX.Equal(26, ulid.Length, "ulid length");

            var noSalt = new WardxOptions
            {
                Endpoint = "http://127.0.0.1:1",
                ProjectKey = "k",
                Project = "p",
                Role = "unity",
                AppVersion = "1",
                Environment = "test"
            };
            AssertX.Throws(() => Settings.Resolve(noSalt), "privacySalt");
            baseOpts.HistogramBuckets = null;
            baseOpts.MaxFrameBytes = 1023;
            AssertX.Throws(() => Settings.Resolve(baseOpts), "at least 1024");
            baseOpts.MaxFrameBytes = null;
            foreach (var capacity in new[] { 0, -1 })
            {
                baseOpts.MaxPendingFrames = capacity;
                AssertX.Throws(() => Settings.Resolve(baseOpts), "maxPendingFrames");
            }
            baseOpts.MaxPendingFrames = null;
            baseOpts.ExperimentStateMaxSubjects = 0;
            AssertX.Throws(() => Settings.Resolve(baseOpts), "experimentStateMaxSubjects");
        }
    }
}
