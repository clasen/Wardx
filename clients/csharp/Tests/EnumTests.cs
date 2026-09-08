using System;
using System.Collections.Generic;
using System.Linq;

namespace Wardx.Tests
{
    static class EnumTests
    {
        enum Signal
        {
            [WardxName("match.completed")] Completed,
            Online,
            Size,
            Unique,
            Duration,
            [WardxName("message.sent")] Sent,
            [WardxName("message.delayMs")] Delay
        }

        enum Dimension { [WardxName("mode")] Mode, Result }
        enum Mode { [WardxName("ranked")] Ranked, Casual }
        enum Alias { First, Second = First }
        enum InvalidName { [WardxName(" ")] Value }
        [Flags]
        enum Flags { One = 1, Two = 2, Both = One | Two }

        public static void Run()
        {
            var transport = new MemoryTransport();
            var client = new WardxClient(Fixtures.TestSettings(), transport, () => 0,
                new SdkIdentity { Name = "wardx-csharp", Version = "test", Platform = "csharp" });
            var dims = Dims.Of(Dimension.Mode, Mode.Ranked);
            client.Counter(Signal.Completed, dims).Inc();
            client.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
            client.Gauge(Signal.Online).Set(3);
            client.Histogram(Signal.Size).Observe(42, dims);
            client.Distinct(Signal.Unique, dims).Add("user");
            client.Timer(Signal.Duration, dims).Stop(Dims.Of(Dimension.Result, Mode.Casual));
            client.Event(Signal.Completed, dims);
            client.Log.Debug(Signal.Completed, dims);
            client.Log.Info(Signal.Completed, dims);
            client.Log.Warn(Signal.Completed, dims);
            client.Log.Error(Signal.Completed, dims);

            client.Core.ApplyConfig(1, new Dictionary<string, object> { ["message.delayMs"] = 1000 },
                new List<ExperimentDefinition> { Fixtures.MessageDelay() });
            AssertX.Equal(7, client.Config.Get(Signal.Online, 7), "enum fallback");
            AssertX.Equal(1000, client.Config.Get(Signal.Delay, 7), "shared enum key");
            client.Identify("subject");
            AssertX.Equal(client.Config.Get("message.delayMs", 7), client.Config.Get(Signal.Delay, 7), "same variant");
            client.Experiment.Goal(Signal.Sent, value: 2);
            AssertX.Equal(client.Config.Get("message.delayMs", 7, "other"),
                client.Config.Get(Signal.Delay, 7, "other"), "explicit subject");
            client.Experiment.Goal(Signal.Sent, "other", 3);

            client.FlushAsync().GetAwaiter().GetResult();
            var frame = Json.Parse(transport.LastJson)["frames"].ArrayValue.Single();
            var counter = frame["metrics"]["counters"].ArrayValue.Single(r => r.ArrayValue[0].StringValue == "match.completed");
            AssertX.Equal(2.0, counter.ArrayValue[2].NumberValue, "enum and string share a series");
            AssertX.Equal("ranked", counter.ArrayValue[1]["mode"].StringValue);
            AssertX.Equal(3.0, frame["metrics"]["gauges"].ArrayValue.Single(r => r.ArrayValue[0].StringValue == "Online").ArrayValue[2].NumberValue);
            var size = frame["metrics"]["histograms"].ArrayValue.Single(r => r.ArrayValue[0].StringValue == "Size");
            AssertX.Equal("ranked", size.ArrayValue[2]["exemplar"]["attrs"]["mode"].StringValue);
            var duration = frame["metrics"]["histograms"].ArrayValue.Single(r => r.ArrayValue[0].StringValue == "Duration");
            AssertX.Equal("Casual", duration.ArrayValue[1]["Result"].StringValue);
            AssertX.Equal("ranked", frame["metrics"]["distincts"].ArrayValue.Single().ArrayValue[1]["mode"].StringValue);
            var product = frame["events"].ArrayValue.Single(r => r.ArrayValue[1].StringValue == "match.completed");
            AssertX.Equal("ranked", product.ArrayValue[2]["mode"].StringValue);
            var goals = frame["events"].ArrayValue.Where(r => r.ArrayValue[1].StringValue == "experiment.goal").ToArray();
            AssertX.Equal(2, goals.Length);
            AssertX.Equal("message.sent", goals[0].ArrayValue[2]["metric"].StringValue);
            AssertX.Equal(2.0, goals[0].ArrayValue[2]["value"].NumberValue);
            foreach (var log in frame["logs"].ArrayValue)
            {
                AssertX.Equal("match.completed", log.ArrayValue[2].StringValue);
                AssertX.Equal("ranked", log.ArrayValue[3]["mode"].StringValue);
            }
            AssertX.Equal(4, frame["logs"].ArrayValue.Count);
            AssertX.Equal(Mode.Ranked, (Mode)dims["mode"], "caller dictionary is not mutated");
            client.Stop();

            CoreAndDimensions();
            InvalidValues();
        }

        static void CoreAndDimensions()
        {
            var core = new WardxCore(Fixtures.TestSettings());
            var dims = new Dictionary<string, object> { ["mode"] = Mode.Ranked };
            core.Counter(Signal.Completed, dims).Inc();
            core.Counter("match.completed", Dims.Of("mode", "ranked")).Inc();
            core.Gauge(Signal.Online, dims).Set(5);
            core.Histogram(Signal.Size, dims).Observe(1);
            core.Distinct(Signal.Unique, dims).Add("user");
            core.Timer(Signal.Duration, dims).Stop();
            core.Event(Signal.Completed, dims);
            core.Log.Debug(Signal.Completed, dims);
            core.Log.Info(Signal.Completed, dims);
            core.Log.Warn(Signal.Completed, dims);
            core.Log.Error(Signal.Completed, dims);
            AssertX.Equal(7, core.ConfigGet(Signal.Delay, 7));
            AssertX.Throws(() => core.ExperimentGoal(Signal.Sent), "requires subjectId");
            core.ApplyConfig(1, new Dictionary<string, object> { ["message.delayMs"] = 1000 },
                new List<ExperimentDefinition> { Fixtures.MessageDelay() });
            core.ConfigGet(Signal.Delay, 7, "subject");
            core.ExperimentGoal(Signal.Sent, "subject", 1);
            var frame = core.SnapshotFrame().Frames.Single();
            AssertX.Equal(2.0, frame.Counters.Single(r => r.Name == "match.completed").Value);
            AssertX.Equal("ranked", (string)frame.Gauges.Single(r => r.Name == "Online").Dims["mode"]);
            AssertX.Equal("ranked", (string)frame.Events.First().Attrs["mode"]);
            AssertX.Equal(1, frame.Events.Count(r => r.Name == "experiment.goal"));
            AssertX.Equal(4, frame.Logs.Count);

            AssertX.Equal(2, Dims.Of(Dimension.Mode, Mode.Ranked, "other", true).Count);
            AssertX.Equal(3, Dims.Of("other", true, Dimension.Mode, Mode.Ranked, Dimension.Result, "ok").Count);
            AssertX.Equal(3, Dims.Of(Dimension.Mode, Mode.Ranked, "other", true, "last", 1).Count);
            AssertX.Throws(() => Dims.Of(42, "value"), "string or enum");
            var limited = Dimensions.Validate(dims, 8, 3);
            AssertX.True(!limited.IsOk, "mapped enum values obey dimension limits");
            AssertX.Equal("maxDimensionValueLength", limited.Reason);
            AssertX.Equal(Mode.Ranked, (Mode)dims["mode"]);
        }

        static void InvalidValues()
        {
            var core = new WardxCore(Fixtures.TestSettings());
            AssertX.Throws(() => core.Counter((Signal)999), "declared member");
            AssertX.Throws(() => core.Counter(Alias.First), "ambiguous");
            AssertX.Throws(() => core.Counter(InvalidName.Value), "nonblank");
            AssertX.Throws(() => core.Counter((Flags)4), "declared member");
            core.Counter(Flags.One | Flags.Two).Inc();
            AssertX.Equal("Both", core.SnapshotFrame().Frames.Single().Counters.First().Name);
            AssertX.Throws(() => core.Counter("invalid", Dims.Of("mode", (Mode)999)), "declared member");
            AssertX.Throws(() => core.Event("invalid", Dims.Of("mode", (Mode)999)), "declared member");
            AssertX.Throws(() => core.Log.Info("invalid", Dims.Of("mode", (Mode)999)), "declared member");
            AssertX.Throws(() => core.Counter(null), "non-empty string");
        }
    }
}
