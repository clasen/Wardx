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
            AssertX.Equal(1, first.Frame.Events.Count, "first events");
            AssertX.Equal("a", first.Frame.Events[0].Name, "event a");
            AssertX.Equal(1, second.Frame.Events.Count, "second events");
            AssertX.Equal("b", second.Frame.Events[0].Name, "event b");
            var found = false;
            foreach (var row in first.Frame.Counters)
            {
                if (row.Name == "n")
                {
                    found = true;
                    AssertX.Equal(4.0, row.Value, "counter 4");
                }
            }
            AssertX.True(found, "counter n present");
            AssertX.Equal(first.Frame.Seq + 1, second.Frame.Seq, "seq");

            var core2 = new WardxCore(Fixtures.TestSettings(o => o.MaxBufferedEvents = 1));
            core2.Event("keep");
            core2.Event("drop-me");
            var fitted = core2.SnapshotFrame();
            var dropped = 0.0;
            foreach (var row in fitted.Frame.Counters)
            {
                if (row.Name == Protocol.Internal.EventsDropped) dropped = row.Value;
            }
            AssertX.Equal(1.0, dropped, "events_dropped");

            var events = new List<EventSample>();
            for (var i = 0; i < 200; i++)
            {
                events.Add(new EventSample(i, "e", Dims.Of("pad", new string('y', 80))));
            }
            var frame = Bare(events, new List<LogSample>());
            var trimmed = FrameBuilder.FitToMaxBytes(frame, 4096);
            AssertX.True(trimmed.DroppedEvents > 0, "dropped events");
            AssertX.Equal(200, trimmed.DroppedEvents + trimmed.Frame.Events.Count, "prefix preserved count");
            AssertX.Equal(0L, trimmed.Frame.Events[0].Time, "kept prefix");
            AssertX.True(Encoding.UTF8.GetByteCount(trimmed.Json) <= 4096, "fits 4096");

            var logs = new List<LogSample>
            {
                new LogSample(1, "error", "keep-error", Dims.Of("pad", new string('x', 40))),
                new LogSample(2, "debug", "drop-debug", Dims.Of("pad", new string('x', 40))),
                new LogSample(3, "error", "keep-error-2", Dims.Of("pad", new string('x', 40)))
            };
            var logFrame = Bare(new List<EventSample>(), logs);
            var full = Encoding.UTF8.GetByteCount(Json.Stringify(logFrame.ToWire()));
            var logTrim = FrameBuilder.FitToMaxBytes(logFrame, full - 10);
            AssertX.Equal(1, logTrim.DroppedLogs, "one log dropped");
            AssertX.Equal(2, logTrim.Frame.Logs.Count, "two logs kept");
            AssertX.Equal("keep-error", logTrim.Frame.Logs[0].Message, "error 1");
            AssertX.Equal("keep-error-2", logTrim.Frame.Logs[1].Message, "error 2");
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
                Environment = "test"
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
        }
    }
}
