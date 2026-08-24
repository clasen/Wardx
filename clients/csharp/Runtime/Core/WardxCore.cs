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
        string _subjectId;

        public readonly InternalMetrics Internal = new InternalMetrics();
        public readonly ConfigStore ConfigStore = new ConfigStore();
        public readonly CoreLogApi Log;

        internal ExperimentResolver ExperimentResolver => _experiments;

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
            _experiments = new ExperimentResolver(settings.PrivacySalt, settings.ExperimentStateMaxSubjects, payload =>
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

        public void Identify(string subjectId)
        {
            if (subjectId != null && subjectId.Length == 0)
            {
                throw new ArgumentException("identify requires a non-empty subjectId");
            }
            _subjectId = subjectId;
        }

        string ResolveSubjectId(string subjectId)
        {
            return subjectId ?? _subjectId;
        }

        public object ConfigGet(string key, object fallback, string subjectId = null)
        {
            if (!ConfigStore.Has(key)) return fallback;
            var remote = ConfigStore.GetRaw(key);
            var resolved = ResolveSubjectId(subjectId);
            if (resolved == null) return remote;
            return _experiments.Resolve(key, remote, resolved, ConfigStore.ExperimentsByKey);
        }

        public T ConfigGet<T>(string key, T fallback, string subjectId = null)
        {
            var value = ConfigGet(key, (object)fallback, subjectId);
            if (value is T typed) return typed;
            if (value == null) return fallback;
            return (T)Convert.ChangeType(value, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
        }

        public void ExperimentGoal(string name, string subjectId = null, object value = null)
        {
            subjectId = ResolveSubjectId(subjectId);
            if (subjectId == null)
            {
                throw new ArgumentException("experiment.goal requires subjectId");
            }
            if (string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("experiment.goal requires a metric name");
            }
            var assignment = _experiments.ExposedAssignmentForGoal(subjectId, name);
            if (assignment == null) return;
            var subject = _experiments.HashSubject(subjectId);
            var payload = new Dictionary<string, object>
            {
                ["metric"] = name,
                ["subject"] = subject,
                ["experiments"] = AssignmentWire(assignment)
            };
            if (value != null) payload["value"] = value;
            Event("experiment.goal", payload);
        }

        public void ApplyConfig(int version, Dictionary<string, object> values, List<ExperimentDefinition> experiments)
        {
            ConfigStore.ApplySnapshot(version, values, experiments);
            _experiments.ApplySnapshot(ConfigStore.Experiments);
            Internal.ConfigVersion = version;
        }

        public FrameBatch SnapshotIfDirty()
        {
            if (!_metrics.IsDirty() && _events.Length == 0 && _logs.Length == 0 && !Internal.HasCounterActivity())
            {
                return null;
            }
            return SnapshotFrame();
        }

        public FrameBatch SnapshotFrame()
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
            var frame = FrameBuilder.Build(_seq + 1, from, to, metrics, events, logs, internalSnap);
            var batch = FrameBuilder.SplitToMaxBytes(frame, _settings.MaxFrameBytes);
            _seq = batch.Frames[batch.Frames.Count - 1].Seq;
            _pendingFrames.AddRange(batch.Frames);
            for (int i = 0; i < batch.Frames.Count; i++)
            {
                var physical = batch.Frames[i];
                TracerEmit.Frame(_tracer, new FrameRecord
                {
                    Seq = physical.Seq,
                    From = physical.From,
                    To = physical.To,
                    Counters = physical.Counters.Count,
                    Gauges = physical.Gauges.Count,
                    Histograms = physical.Histograms.Count,
                    Events = physical.Events.Count,
                    Logs = physical.Logs.Count,
                    DroppedLogs = i == 0 ? batch.DroppedLogs : 0,
                    DroppedEvents = i == 0 ? batch.DroppedEvents : 0,
                    DroppedRows = i == 0 ? batch.DroppedRows : 0
                });
            }
            return batch;
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

        static List<object> AssignmentWire(ExperimentAssignment assignment)
        {
            return new List<object>
            {
                new Dictionary<string, object>
                {
                    ["experiment"] = assignment.Experiment,
                    ["variant"] = assignment.Variant
                }
            };
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
