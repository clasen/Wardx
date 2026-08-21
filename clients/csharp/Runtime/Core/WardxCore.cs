using System;
using System.Collections.Generic;

namespace Wardx
{
    public sealed class WardxCore
    {
        readonly Settings _settings;
        readonly ITracer _tracer;
        readonly Dictionary<object, object> _wrappers;
        readonly MetricsRegistry _metrics;
        readonly EventBuffer _events;
        readonly LogBuffer _logs;
        readonly ExperimentResolver _experiments;
        int _seq;
        List<Frame> _pendingFrames = new List<Frame>();
        long _windowStart;

        public readonly InternalMetrics Internal = new InternalMetrics();
        public readonly ConfigStore ConfigStore = new ConfigStore();
        public readonly CoreLogApi Log;

        public WardxCore(Settings settings)
        {
            _settings = settings;
            _tracer = settings.Tracer;
            _wrappers = _tracer != null ? new Dictionary<object, object>() : null;
            _metrics = new MetricsRegistry(
                settings.MaxSeriesPerMetric,
                settings.MaxDimensionKeys,
                settings.MaxDimensionValueLength,
                settings.HistogramBuckets,
                () => { Internal.CardinalityDropped += 1; }
            );
            _events = new EventBuffer(settings.MaxBufferedEvents);
            _logs = new LogBuffer(settings.MaxBufferedLogs);
            _experiments = new ExperimentResolver(settings.PrivacySalt, payload =>
            {
                Event("experiment.exposure", payload);
            });
            _windowStart = Clock.UnixMs();
            Log = new CoreLogApi(this);
        }

        public ICounter Counter(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            return Wrap(_metrics.Counter(name, dims), NoopCounter.Instance, name, dims,
                (series, noop) => new TracedCounter(series, _tracer, name, dims, noop));
        }

        public IGauge Gauge(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            return Wrap(_metrics.Gauge(name, dims), NoopGauge.Instance, name, dims,
                (series, noop) => new TracedGauge(series, _tracer, name, dims, noop));
        }

        public IHistogram Histogram(string name, IReadOnlyDictionary<string, object> dims = null, double[] buckets = null)
        {
            return Wrap(_metrics.Histogram(name, dims, buckets), NoopHistogram.Instance, name, dims,
                (series, noop) => new TracedHistogram(series, _tracer, name, dims, noop));
        }

        public TimerToken Timer(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            if (_tracer == null) return _metrics.Timer(name, dims);
            var start = System.Diagnostics.Stopwatch.GetTimestamp();
            return new TimerToken(endDims =>
            {
                var duration = (System.Diagnostics.Stopwatch.GetTimestamp() - start) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
                Histogram(name, Dimensions.Merge(dims, endDims)).Observe(duration);
            });
        }

        public void Event(string name, IReadOnlyDictionary<string, object> attrs = null)
        {
            var dropped = !_events.Push(name, attrs);
            if (dropped) Internal.EventsDropped += 1;
            TracerEmit.Event(_tracer, new EventRecord { Name = name, Attrs = attrs, Dropped = dropped });
        }

        internal void WriteLog(string level, string message, IReadOnlyDictionary<string, object> attrs)
        {
            var dropped = !_logs.Push(level, message, attrs);
            if (dropped) Internal.LogsDropped += 1;
            TracerEmit.Log(_tracer, new LogRecord { Level = level, Message = message, Attrs = attrs, Dropped = dropped });
        }

        public object ConfigGet(string key, object fallback, string subjectId = null)
        {
            if (!ConfigStore.Has(key)) return fallback;
            var remote = ConfigStore.GetRaw(key);
            if (subjectId == null) return remote;
            return _experiments.Resolve(key, remote, subjectId, ConfigStore.ExperimentsByKey);
        }

        public T ConfigGet<T>(string key, T fallback, string subjectId = null)
        {
            var value = ConfigGet(key, (object)fallback, subjectId);
            if (value is T typed) return typed;
            if (value == null) return fallback;
            return (T)Convert.ChangeType(value, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
        }

        public void ExperimentGoal(string name, string subjectId, object value = null)
        {
            if (subjectId == null)
            {
                throw new ArgumentException("experiment.goal requires subjectId");
            }
            if (string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("experiment.goal requires a metric name");
            }
            var subject = _experiments.HashSubject(subjectId);
            var experiments = _experiments.RelevantExperiments(subjectId, ConfigStore.Experiments);
            var payload = new Dictionary<string, object>
            {
                ["metric"] = name,
                ["subject"] = subject,
                ["experiments"] = AssignmentWire(experiments)
            };
            if (value != null) payload["value"] = value;
            Event("experiment.goal", payload);
        }

        public void ApplyConfig(int version, Dictionary<string, object> values, List<ExperimentDefinition> experiments)
        {
            ConfigStore.ApplySnapshot(version, values, experiments);
            Internal.ConfigVersion = version;
        }

        public FittedFrame SnapshotIfDirty()
        {
            if (!_metrics.IsDirty() && _events.Length == 0 && _logs.Length == 0 && !Internal.HasCounterActivity())
            {
                return null;
            }
            return SnapshotFrame();
        }

        public FittedFrame SnapshotFrame()
        {
            var to = Clock.UnixMs();
            var from = _windowStart;
            _windowStart = to;
            Internal.EventsBuffered = _events.Length;
            Internal.LogsBuffered = _logs.Length;
            var metrics = _metrics.SnapshotAndReset();
            var events = _events.Swap();
            var logs = _logs.Swap();
            var internalSnap = Internal.SnapshotAndReset();
            var frame = FrameBuilder.Build(++_seq, from, to, metrics, events, logs, internalSnap);
            var fitted = FrameBuilder.FitToMaxBytes(frame, _settings.MaxFrameBytes);
            Internal.LogsDropped += fitted.DroppedLogs;
            Internal.EventsDropped += fitted.DroppedEvents;
            _pendingFrames.Add(fitted.Frame);
            TracerEmit.Frame(_tracer, new FrameRecord
            {
                Seq = fitted.Frame.Seq,
                From = fitted.Frame.From,
                To = fitted.Frame.To,
                Counters = fitted.Frame.Counters.Count,
                Gauges = fitted.Frame.Gauges.Count,
                Histograms = fitted.Frame.Histograms.Count,
                Events = fitted.Frame.Events.Count,
                Logs = fitted.Frame.Logs.Count,
                DroppedLogs = fitted.DroppedLogs,
                DroppedEvents = fitted.DroppedEvents
            });
            return fitted;
        }

        public List<Frame> TakePendingFrames()
        {
            var frames = _pendingFrames;
            _pendingFrames = new List<Frame>();
            return frames;
        }

        T Wrap<T>(T series, T noopSentinel, string name, IReadOnlyDictionary<string, object> dims, Func<T, bool, T> factory)
            where T : class
        {
            if (_tracer == null) return series;
            if (ReferenceEquals(series, noopSentinel)) return factory(series, true);
            if (_wrappers.TryGetValue(series, out var cached)) return (T)cached;
            var wrapped = factory(series, false);
            _wrappers[series] = wrapped;
            return wrapped;
        }

        static List<object> AssignmentWire(List<ExperimentAssignment> assignments)
        {
            var rows = new List<object>(assignments.Count);
            foreach (var row in assignments)
            {
                rows.Add(new Dictionary<string, object>
                {
                    ["experiment"] = row.Experiment,
                    ["variant"] = row.Variant
                });
            }
            return rows;
        }
    }

    public sealed class CoreLogApi
    {
        readonly WardxCore _core;

        internal CoreLogApi(WardxCore core)
        {
            _core = core;
        }

        public void Debug(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _core.WriteLog("debug", message, attrs);
        }

        public void Info(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _core.WriteLog("info", message, attrs);
        }

        public void Warn(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _core.WriteLog("warn", message, attrs);
        }

        public void Error(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _core.WriteLog("error", message, attrs);
        }
    }
}
