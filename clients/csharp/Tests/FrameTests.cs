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
            baseOpts.ExperimentStateMaxSubjects = 0;
            AssertX.Throws(() => Settings.Resolve(baseOpts), "experimentStateMaxSubjects");
        }
    }
}
