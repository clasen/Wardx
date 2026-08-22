using System.Collections.Generic;

namespace Wardx.Tests
{
    static class ExperimentTests
    {
        public static void Run()
        {
            var experiment = Fixtures.MessageDelay();
            var a = Experiments.AssignVariant(experiment, "user-1");
            var b = Experiments.AssignVariant(experiment, "user-1");
            AssertX.Equal(a.Key, b.Key, "deterministic variant");

            var original = Experiments.AssignVariant(experiment, "user-stable");
            var changedSalt = new ExperimentDefinition
            {
                Id = experiment.Id,
                Enabled = true,
                Allocation = 1,
                Salt = "other",
                Variants = experiment.Variants
            };
            var hashA = Hash.AssignmentHash(experiment.Id, "user-stable", experiment.Salt);
            var hashB = Hash.AssignmentHash(experiment.Id, "user-stable", "other");
            AssertX.True(hashA != hashB, "salt changes hash");
            AssertX.True(original != null, "allocated with full allocation");
            AssertX.True(Experiments.AssignVariant(changedSalt, "user-stable") != null, "still allocated");

            var partial = new ExperimentDefinition
            {
                Id = experiment.Id,
                Enabled = true,
                Allocation = 0.2,
                Salt = experiment.Salt,
                Variants = experiment.Variants
            };
            var inExp = 0;
            var outExp = 0;
            for (var i = 0; i < 5000; i++)
            {
                if (Experiments.AssignVariant(partial, "s-" + i) != null) inExp++;
                else outExp++;
            }
            var ratio = inExp / (double)(inExp + outExp);
            AssertX.True(ratio > 0.15 && ratio < 0.25, "allocation ratio " + ratio);

            var core = new WardxCore(Fixtures.TestSettings());
            AssertX.Equal(7, core.ConfigGet<int>("message.delayMs", 7), "fallback");
            core.ApplyConfig(13, new Dictionary<string, object> { ["message.delayMs"] = 1000 }, new List<ExperimentDefinition> { experiment });
            AssertX.Equal(1000, core.ConfigGet<int>("message.delayMs", 7), "remote");
            var withSubject = core.ConfigGet<int>("message.delayMs", 7, "user-1");
            AssertX.True(withSubject == 1000 || withSubject == 400, "variant or remote");

            var core2 = new WardxCore(Fixtures.TestSettings());
            core2.ApplyConfig(1, new Dictionary<string, object> { ["message.delayMs"] = 1000 }, new List<ExperimentDefinition> { experiment });
            core2.ConfigGet("message.delayMs", 7, "user-1");
            core2.ConfigGet("message.delayMs", 7, "user-1");
            var fitted = core2.SnapshotFrame();
            var exposures = 0;
            string subject = null;
            foreach (var row in fitted.Frame.Events)
            {
                if (row.Name != "experiment.exposure") continue;
                exposures++;
                subject = (string)row.Attrs["subject"];
            }
            AssertX.Equal(1, exposures, "one exposure");
            AssertX.True(subject != null && subject != "user-1", "hashed subject");

            core2.ExperimentGoal("message.sent", "user-1", 1);
            var fitted2 = core2.SnapshotFrame();
            var goals = 0;
            foreach (var row in fitted2.Frame.Events)
            {
                if (row.Name != "experiment.goal") continue;
                goals++;
                AssertX.Equal("message.sent", (string)row.Attrs["metric"], "goal metric");
                var experiments = (System.Collections.IList)row.Attrs["experiments"];
                AssertX.Equal(1, experiments.Count, "known assignments");
            }
            AssertX.Equal(1, goals, "one goal");

            var identified = new WardxCore(Fixtures.TestSettings());
            identified.ApplyConfig(1, new Dictionary<string, object> { ["message.delayMs"] = 1000 }, new List<ExperimentDefinition> { experiment });
            AssertX.Equal(1000, identified.ConfigGet<int>("message.delayMs", 7), "remote before identify");
            identified.Identify("user-1");
            var fromIdentify = identified.ConfigGet<int>("message.delayMs", 7);
            var fromCall = identified.ConfigGet<int>("message.delayMs", 7, "user-1");
            AssertX.Equal(fromCall, fromIdentify, "identify matches per-call subject");
            AssertX.True(fromIdentify == 1000 || fromIdentify == 400, "identified variant or remote");
            identified.ExperimentGoal("message.sent", null, 1);
            var identifiedFrame = identified.SnapshotFrame();
            var identifiedGoals = 0;
            var identifiedExposures = 0;
            foreach (var row in identifiedFrame.Frame.Events)
            {
                if (row.Name == "experiment.exposure") identifiedExposures++;
                if (row.Name != "experiment.goal") continue;
                identifiedGoals++;
                AssertX.Equal("message.sent", (string)row.Attrs["metric"], "identified goal metric");
            }
            AssertX.Equal(1, identifiedExposures, "identify exposure");
            AssertX.Equal(1, identifiedGoals, "identify goal");

            identified.Identify("user-1");
            var overrideValue = identified.ConfigGet<int>("message.delayMs", 7, "user-2");
            AssertX.Equal(overrideValue, identified.ConfigGet<int>("message.delayMs", 7, "user-2"), "per-call overrides identify");
            identified.Identify(null);
            AssertX.Equal(1000, identified.ConfigGet<int>("message.delayMs", 7), "cleared identify is remote");
            var goalThrew = false;
            try { identified.ExperimentGoal("message.sent"); }
            catch (System.ArgumentException) { goalThrew = true; }
            AssertX.True(goalThrew, "goal without subject throws");
            var emptyThrew = false;
            try { identified.Identify(""); }
            catch (System.ArgumentException) { emptyThrew = true; }
            AssertX.True(emptyThrew, "empty identify throws");

            var hash = Hash.AssignmentHash(experiment.Id, "x", experiment.Salt);
            var unit = Hash.HashToUnitInterval(hash);
            AssertX.True(unit >= 0 && unit < 1, "unit interval");
        }
    }
}
