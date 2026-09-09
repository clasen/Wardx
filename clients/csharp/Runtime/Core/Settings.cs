using System;
using System.Collections.Generic;

namespace Wardx
{
    public sealed class WardxOptions
    {
        public bool Enabled = true;
        public string Endpoint;
        public string ProjectKey;
        public string Project;
        public string Role;
        public string AppVersion;
        public string Environment;
        public IReadOnlyDictionary<string, object> Attributes;
        public string PrivacySalt;
        public ITracer Tracer;
        public int? AggregateIntervalMs;
        public int? SyncIntervalMs;
        public double? SyncJitterMin;
        public double? SyncJitterMax;
        public int? MaxBufferedEvents;
        public int? MaxBufferedLogs;
        public int? MaxFrameBytes;
        public int? MaxSeriesPerMetric;
        public int? MaxDimensionKeys;
        public int? MaxDimensionValueLength;
        public int? ExperimentStateMaxSubjects;
        public int? HttpTimeoutMs;
        public double[] HistogramBuckets;
    }

    public sealed class Settings
    {
        public bool Enabled = true;
        public string Endpoint;
        public string ProjectKey;
        public string Project;
        public string Role;
        public string AppVersion;
        public string Environment;
        public IReadOnlyDictionary<string, object> Attributes;
        public string PrivacySalt;
        public ITracer Tracer;
        public int AggregateIntervalMs;
        public int SyncIntervalMs;
        public double SyncJitterMin;
        public double SyncJitterMax;
        public int MaxBufferedEvents;
        public int MaxBufferedLogs;
        public int MaxFrameBytes;
        public int MaxSeriesPerMetric;
        public int MaxDimensionKeys;
        public int MaxDimensionValueLength;
        public int ExperimentStateMaxSubjects;
        public int HttpTimeoutMs;
        public double[] HistogramBuckets;

        public static Settings Resolve(WardxOptions options)
        {
            if (options == null) throw new ArgumentException("createWardx requires an options object");
            if (!options.Enabled) return new Settings { Enabled = false };
            var missing = new List<string>();
            Require(options.Endpoint, "endpoint", missing);
            Require(options.ProjectKey, "projectKey", missing);
            Require(options.Project, "project", missing);
            Require(options.Role, "role", missing);
            Require(options.AppVersion, "appVersion", missing);
            Require(options.Environment, "environment", missing);
            Require(options.PrivacySalt, "privacySalt", missing);
            if (missing.Count > 0)
            {
                throw new ArgumentException("createWardx missing required keys: " + string.Join(", ", missing.ToArray()));
            }
            if (options.Role.Length == 0)
            {
                throw new ArgumentException("role must be a non-empty string");
            }
            if (options.Role == "*")
            {
                throw new ArgumentException("role cannot be *");
            }

            var settings = new Settings
            {
                Endpoint = options.Endpoint,
                ProjectKey = options.ProjectKey,
                Project = options.Project,
                Role = options.Role,
                AppVersion = options.AppVersion,
                Environment = options.Environment,
                Attributes = options.Attributes,
                PrivacySalt = options.PrivacySalt,
                Tracer = options.Tracer,
                AggregateIntervalMs = options.AggregateIntervalMs ?? SdkDefaults.AggregateIntervalMs,
                SyncIntervalMs = options.SyncIntervalMs ?? SdkDefaults.SyncIntervalMs,
                SyncJitterMin = options.SyncJitterMin ?? SdkDefaults.SyncJitterMin,
                SyncJitterMax = options.SyncJitterMax ?? SdkDefaults.SyncJitterMax,
                MaxBufferedEvents = options.MaxBufferedEvents ?? SdkDefaults.MaxBufferedEvents,
                MaxBufferedLogs = options.MaxBufferedLogs ?? SdkDefaults.MaxBufferedLogs,
                MaxFrameBytes = options.MaxFrameBytes ?? SdkDefaults.MaxFrameBytes,
                MaxSeriesPerMetric = options.MaxSeriesPerMetric ?? SdkDefaults.MaxSeriesPerMetric,
                MaxDimensionKeys = options.MaxDimensionKeys ?? SdkDefaults.MaxDimensionKeys,
                MaxDimensionValueLength = options.MaxDimensionValueLength ?? SdkDefaults.MaxDimensionValueLength,
                ExperimentStateMaxSubjects = options.ExperimentStateMaxSubjects ?? SdkDefaults.ExperimentStateMaxSubjects,
                HttpTimeoutMs = options.HttpTimeoutMs ?? SdkDefaults.HttpTimeoutMs,
                HistogramBuckets = options.HistogramBuckets ?? SdkDefaults.HistogramBuckets
            };

            if (settings.PrivacySalt.Length == 0)
            {
                throw new ArgumentException("privacySalt must be a non-empty string");
            }

            AssertPositive(settings.AggregateIntervalMs, "aggregateIntervalMs");
            AssertPositive(settings.SyncIntervalMs, "syncIntervalMs");
            AssertPositive(settings.MaxBufferedEvents, "maxBufferedEvents");
            AssertPositive(settings.MaxBufferedLogs, "maxBufferedLogs");
            AssertPositive(settings.MaxFrameBytes, "maxFrameBytes");
            if (settings.MaxFrameBytes < 1024)
            {
                throw new ArgumentException("maxFrameBytes must be at least 1024");
            }
            AssertPositive(settings.MaxSeriesPerMetric, "maxSeriesPerMetric");
            AssertPositive(settings.MaxDimensionKeys, "maxDimensionKeys");
            AssertPositive(settings.MaxDimensionValueLength, "maxDimensionValueLength");
            AssertPositive(settings.ExperimentStateMaxSubjects, "experimentStateMaxSubjects");
            AssertPositive(settings.HttpTimeoutMs, "httpTimeoutMs");
            AssertRange(settings.SyncJitterMin, 0, 1, "syncJitterMin");
            AssertRange(settings.SyncJitterMax, 1, 2, "syncJitterMax");
            if (settings.SyncJitterMin > settings.SyncJitterMax)
            {
                throw new ArgumentException("syncJitterMin must be <= syncJitterMax");
            }
            if (settings.HistogramBuckets == null || settings.HistogramBuckets.Length == 0)
            {
                throw new ArgumentException("histogramBuckets must be a non-empty array");
            }
            var prev = double.NegativeInfinity;
            foreach (var bound in settings.HistogramBuckets)
            {
                if (double.IsNaN(bound) || double.IsInfinity(bound) || bound <= prev)
                {
                    throw new ArgumentException("histogramBuckets must be strictly increasing finite numbers");
                }
                prev = bound;
            }
            return settings;
        }

        static readonly Random Jitter = new Random();

        public static int NextSyncDelayMs(Settings settings)
        {
            double factor;
            lock (Jitter)
            {
                var span = settings.SyncJitterMax - settings.SyncJitterMin;
                factor = settings.SyncJitterMin + Jitter.NextDouble() * span;
            }
            return (int)Math.Round(settings.SyncIntervalMs * factor);
        }

        static void Require(string value, string key, List<string> missing)
        {
            if (value == null) missing.Add(key);
        }

        static void AssertPositive(int value, string key)
        {
            if (value <= 0) throw new ArgumentException(key + " must be a finite number > 0");
        }

        static void AssertRange(double value, double min, double max, string key)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || value < min || value > max)
            {
                throw new ArgumentException(key + " must be a finite number in [" + min + ", " + max + "]");
            }
        }
    }
}
