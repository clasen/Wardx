using System;
using System.Collections.Generic;

namespace Wardx.Tests
{
    static class AssertX
    {
        public static void Equal<T>(T expected, T actual, string message = null)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new Exception((message ?? "values should be equal") + ": expected <" + expected + "> got <" + actual + ">");
            }
        }

        public static void True(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
        }

        public static void Throws(Action action, string contains)
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                if (ex.Message.IndexOf(contains, StringComparison.Ordinal) < 0)
                {
                    throw new Exception("thrown message should contain <" + contains + "> got <" + ex.Message + ">");
                }
                return;
            }
            throw new Exception("expected throw containing <" + contains + ">");
        }
    }

    static class Fixtures
    {
        public static Settings TestSettings(Action<WardxOptions> overrideOptions = null)
        {
            var options = new WardxOptions
            {
                Endpoint = "http://127.0.0.1:9",
                ProjectKey = "test-key",
                Project = "demo",
                Role = "unity",
                AppVersion = "0.0.0",
                Environment = "test",
                PrivacySalt = "test-salt"
            };
            overrideOptions?.Invoke(options);
            return Settings.Resolve(options);
        }

        public static ExperimentDefinition MessageDelay()
        {
            return new ExperimentDefinition
            {
                Id = "message-delay-v1",
                Enabled = true,
                Allocation = 1,
                Salt = "3ad8f9",
                GoalMetric = "message.sent",
                PrimaryMetric = "message.sent",
                Variants = new List<VariantDefinition>
                {
                    new VariantDefinition
                    {
                        Key = "control",
                        Weight = 50,
                        Values = new Dictionary<string, object> { ["message.delayMs"] = 1000 }
                    },
                    new VariantDefinition
                    {
                        Key = "fast",
                        Weight = 50,
                        Values = new Dictionary<string, object> { ["message.delayMs"] = 400 }
                    }
                }
            };
        }
    }
}
