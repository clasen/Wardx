using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Wardx
{
    public sealed class WardxClient : IDisposable
    {
        readonly Settings _settings;
        readonly WardxCore _core;
        readonly ISyncTransport _transport;
        readonly Func<long> _readRssBytes;
        readonly SdkIdentity _sdk;
        readonly object _gate = new object();
        readonly object _lifecycleGate = new object();
        readonly SemaphoreSlim _syncLock = new SemaphoreSlim(1, 1);
        readonly string _instanceId;
        readonly string _sessionId;
        Action _stopScheduler;
        bool _stopped;
        Task _shutdownTask;

        public LogApi Log { get; }
        public ConfigApi Config { get; }
        public ExperimentApi Experiment { get; }

        internal WardxClient(Settings settings, ISyncTransport transport, Func<long> readRssBytes, SdkIdentity sdk)
        {
            _settings = settings;
            _core = new WardxCore(settings);
            _transport = transport;
            _readRssBytes = readRssBytes ?? (() => 0);
            _sdk = sdk;
            _instanceId = Ids.Ulid();
            _sessionId = Ids.Ulid();
            Log = new LogApi(this);
            Config = new ConfigApi(this);
            Experiment = new ExperimentApi(this);
        }

        internal void AttachScheduler(Action stopScheduler)
        {
            _stopScheduler = stopScheduler;
        }

        internal WardxCore Core => _core;

        public static WardxClient Create(WardxOptions options)
        {
#if UNITY
            return UnityBootstrap.Start(Settings.Resolve(options));
#else
            return DotnetBootstrap.Start(Settings.Resolve(options));
#endif
        }

        public static WardxClient Create(WardxOptions options, ISyncTransport transport)
        {
            return new WardxClient(Settings.Resolve(options), transport, () => 0, DefaultIdentity());
        }

        static SdkIdentity DefaultIdentity()
        {
#if UNITY
            return new SdkIdentity { Name = "wardx-unity", Version = SdkDefaults.Version, Platform = "unity" };
#else
            return new SdkIdentity { Name = "wardx-csharp", Version = SdkDefaults.Version, Platform = "csharp" };
#endif
        }

        public ICounter Counter(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            lock (_gate) return new LockedCounter(_gate, _core.Counter(name, dims));
        }

        public IGauge Gauge(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            lock (_gate) return new LockedGauge(_gate, _core.Gauge(name, dims));
        }

        public IHistogram Histogram(string name, IReadOnlyDictionary<string, object> dims = null, double[] buckets = null)
        {
            lock (_gate) return new LockedHistogram(_gate, _core.Histogram(name, dims, buckets));
        }

        public TimerToken Timer(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            var start = Stopwatch.GetTimestamp();
            return new TimerToken(endDims =>
            {
                var duration = (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
                lock (_gate)
                {
                    _core.Histogram(name, Dimensions.Merge(dims, endDims)).Observe(duration);
                }
            });
        }

        public void Event(string name, IReadOnlyDictionary<string, object> attrs = null)
        {
            lock (_gate) _core.Event(name, attrs);
        }

        public void Identify(string subjectId)
        {
            lock (_gate) _core.Identify(subjectId);
        }

        public Task FlushAsync()
        {
            return EnqueueSync(new SyncFlags { Flush = true });
        }

        public Task ShutdownAsync()
        {
            lock (_lifecycleGate)
            {
                if (_shutdownTask == null) _shutdownTask = ShutdownCoreAsync();
                return _shutdownTask;
            }
        }

        async Task ShutdownCoreAsync()
        {
            _stopped = true;
            _stopScheduler?.Invoke();
            await SettleCurrentSync().ConfigureAwait(false);
            using (var finalFlush = new CancellationTokenSource(_settings.HttpTimeoutMs))
            {
                try
                {
                    await RunSync(new SyncFlags { Flush = true }, finalFlush.Token).ConfigureAwait(false);
                }
                finally
                {
                    _transport.Close();
                }
            }
        }

        async Task SettleCurrentSync()
        {
            await _syncLock.WaitAsync().ConfigureAwait(false);
            _syncLock.Release();
        }

        public void Stop()
        {
            lock (_lifecycleGate)
            {
                if (_stopped) return;
                _stopped = true;
                _stopScheduler?.Invoke();
                _transport.Close();
            }
        }

        public void Dispose()
        {
#if UNITY
            Stop();
#else
            ShutdownAsync().GetAwaiter().GetResult();
#endif
        }

        internal void AggregateTick()
        {
            if (_stopped) return;
            lock (_gate)
            {
                _core.Internal.ProcessRssBytes = _readRssBytes();
                _core.SnapshotIfDirty();
            }
        }

        internal Task EnqueueSync(SyncFlags flags)
        {
            return RunBoundedSync(flags);
        }

        async Task RunBoundedSync(SyncFlags flags)
        {
            using (var timeout = new CancellationTokenSource(_settings.HttpTimeoutMs))
            {
                await RunSync(flags, timeout.Token).ConfigureAwait(false);
            }
        }

        async Task RunSync(SyncFlags flags, CancellationToken transportToken)
        {
            var acquired = false;
            try
            {
                await _syncLock.WaitAsync(transportToken).ConfigureAwait(false);
                acquired = true;
                if (_stopped && !flags.Flush) return;
                await SyncOnceInner(flags, transportToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                lock (_gate) _core.Internal.FramesFailed += 1;
            }
            catch
            {
                lock (_gate) _core.Internal.FramesFailed += 1;
            }
            finally
            {
                if (acquired) _syncLock.Release();
            }
        }

        async Task SyncOnceInner(SyncFlags flags, CancellationToken transportToken)
        {
            List<Frame> frames;
            lock (_gate)
            {
                if (flags.Flush || flags.Bootstrap)
                {
                    _core.Internal.ProcessRssBytes = _readRssBytes();
                    _core.SnapshotIfDirty();
                }
                frames = _core.TakePendingFrames();
            }
            if (!flags.Bootstrap && frames.Count == 0) return;

            var envelope = BuildEnvelope(frames);
            var json = Json.Stringify(envelope);
            var compressed = Gzip.Compress(json);
            var bytesUncompressed = Encoding.UTF8.GetByteCount(json);
            var bytesCompressed = compressed.Length;
            lock (_gate)
            {
                _core.Internal.BytesUncompressed += bytesUncompressed;
                _core.Internal.BytesCompressed += bytesCompressed;
            }
            var started = Stopwatch.GetTimestamp();
            var phase = flags.Bootstrap ? "bootstrap" : flags.Flush ? "flush" : "tick";
            try
            {
                var result = await WithCancellation(
                    _transport.PostAsync(compressed, transportToken),
                    transportToken
                ).ConfigureAwait(false);
                var ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
                lock (_gate) _core.Internal.LastSyncMs = ms;
                if (!result.Ok)
                {
                    lock (_gate) _core.Internal.FramesFailed += Math.Max(frames.Count, 1);
                    TraceSync(phase, frames.Count, bytesUncompressed, bytesCompressed, ms, false, result.Status, false);
                    return;
                }
                lock (_gate)
                {
                    _core.Internal.FramesSent += frames.Count;
                    ApplyResponse(result.Text);
                }
                var applied = false;
                int? version = null;
                lock (_gate)
                {
                    version = _core.ConfigStore.Version;
                    applied = result.Text != null && result.Text.IndexOf("\"config\"", StringComparison.Ordinal) >= 0;
                }
                TraceSync(phase, frames.Count, bytesUncompressed, bytesCompressed, ms, true, result.Status, applied, version);
            }
            catch (OperationCanceledException)
            {
                var ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
                lock (_gate)
                {
                    _core.Internal.LastSyncMs = ms;
                    _core.Internal.FramesFailed += Math.Max(frames.Count, 1);
                }
                TraceSync(phase, frames.Count, bytesUncompressed, bytesCompressed, ms, false, null, false);
            }
            catch
            {
                var ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
                lock (_gate)
                {
                    _core.Internal.LastSyncMs = ms;
                    _core.Internal.FramesFailed += Math.Max(frames.Count, 1);
                }
                TraceSync(phase, frames.Count, bytesUncompressed, bytesCompressed, ms, false, null, false);
            }
        }

        static async Task<T> WithCancellation<T>(Task<T> task, CancellationToken cancellationToken)
        {
            if (task.IsCompleted) return await task.ConfigureAwait(false);
            var canceled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (cancellationToken.Register(() => canceled.TrySetResult(true)))
            {
                if (task != await Task.WhenAny(task, canceled.Task).ConfigureAwait(false))
                {
                    throw new OperationCanceledException(cancellationToken);
                }
            }
            return await task.ConfigureAwait(false);
        }

        Dictionary<string, object> BuildEnvelope(List<Frame> frames)
        {
            var wireFrames = new List<object>(frames.Count);
            foreach (var frame in frames) wireFrames.Add(frame.ToWire());
            int configVersion;
            lock (_gate) configVersion = _core.ConfigStore.Version;
            return new Dictionary<string, object>
            {
                ["protocol"] = Protocol.Version,
                ["project"] = _settings.Project,
                ["sdk"] = new Dictionary<string, object>
                {
                    ["name"] = _sdk.Name,
                    ["version"] = _sdk.Version
                },
                ["client"] = new Dictionary<string, object>
                {
                    ["instanceId"] = _instanceId,
                    ["sessionId"] = _sessionId,
                    ["role"] = _settings.Role,
                    ["appVersion"] = _settings.AppVersion,
                    ["environment"] = _settings.Environment,
                    ["platform"] = _sdk.Platform
                },
                ["configVersion"] = configVersion,
                ["frames"] = wireFrames
            };
        }

        void ApplyResponse(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            JsonNode json;
            try { json = Json.Parse(text); }
            catch { return; }
            if (json == null || !json.IsObject) return;
            var ok = json["ok"];
            if (ok == null || !ok.IsBool || !ok.BoolValue) return;
            var versionNode = json["configVersion"];
            if (versionNode != null && versionNode.Type == JsonNode.Kind.Number)
            {
                _core.Internal.ConfigVersion = versionNode.NumberValue;
            }
            var config = json["config"];
            if (config != null && config.IsObject && versionNode != null)
            {
                var valuesNode = config["values"];
                var experimentsNode = config["experiments"];
                var values = valuesNode != null && valuesNode.IsObject ? valuesNode.ObjectNative() : new Dictionary<string, object>();
                _core.ApplyConfig((int)versionNode.NumberValue, values, ParseExperiments(experimentsNode));
            }
        }

        static List<ExperimentDefinition> ParseExperiments(JsonNode node)
        {
            var list = new List<ExperimentDefinition>();
            if (node == null || node.Type != JsonNode.Kind.Array) return list;
            foreach (var item in node.ArrayValue)
            {
                if (item == null || !item.IsObject) continue;
                var experiment = new ExperimentDefinition
                {
                    Id = item["id"] != null ? item["id"].StringValue : null,
                    Enabled = item["enabled"] != null && item["enabled"].BoolValue,
                    Allocation = item["allocation"] != null ? item["allocation"].NumberValue : 0,
                    Salt = item["salt"] != null ? item["salt"].StringValue : null,
                    GoalMetric = item["goalMetric"] != null ? item["goalMetric"].StringValue : null,
                    Variants = ParseVariants(item["variants"])
                };
                if (item.Has("primaryMetric") && item["primaryMetric"].Type == JsonNode.Kind.String)
                {
                    experiment.PrimaryMetric = item["primaryMetric"].StringValue;
                }
                list.Add(experiment);
            }
            return list;
        }

        static List<VariantDefinition> ParseVariants(JsonNode node)
        {
            var list = new List<VariantDefinition>();
            if (node == null || node.Type != JsonNode.Kind.Array) return list;
            foreach (var item in node.ArrayValue)
            {
                if (item == null || !item.IsObject) continue;
                list.Add(new VariantDefinition
                {
                    Key = item["key"] != null ? item["key"].StringValue : null,
                    Weight = item["weight"] != null ? item["weight"].NumberValue : 0,
                    Values = item["values"] != null && item["values"].IsObject
                        ? item["values"].ObjectNative()
                        : new Dictionary<string, object>()
                });
            }
            return list;
        }

        void TraceSync(string phase, int frames, int bytesUncompressed, int bytesCompressed, double ms, bool ok, int? status, bool applied, int? configVersion = null)
        {
            TracerEmit.Sync(_settings.Tracer, new SyncRecord
            {
                Phase = phase,
                Frames = frames,
                BytesUncompressed = bytesUncompressed,
                BytesCompressed = bytesCompressed,
                Ms = ms,
                Ok = ok,
                Status = status,
                ConfigVersion = configVersion,
                AppliedConfig = applied
            });
        }

        internal object ConfigGet(string key, object fallback, string subjectId)
        {
            lock (_gate) return _core.ConfigGet(key, fallback, subjectId);
        }

        internal T ConfigGet<T>(string key, T fallback, string subjectId)
        {
            lock (_gate) return _core.ConfigGet(key, fallback, subjectId);
        }

        internal void Goal(string name, string subjectId, object value)
        {
            lock (_gate) _core.ExperimentGoal(name, subjectId, value);
        }

        internal void WriteLog(string level, string message, IReadOnlyDictionary<string, object> attrs)
        {
            lock (_gate) _core.WriteLog(level, message, attrs);
        }
    }

    sealed class LockedCounter : ICounter
    {
        readonly object _gate;
        readonly ICounter _inner;

        public LockedCounter(object gate, ICounter inner)
        {
            _gate = gate;
            _inner = inner;
        }

        public void Inc()
        {
            lock (_gate) _inner.Inc();
        }

        public void Add(double n)
        {
            lock (_gate) _inner.Add(n);
        }
    }

    sealed class LockedGauge : IGauge
    {
        readonly object _gate;
        readonly IGauge _inner;

        public LockedGauge(object gate, IGauge inner)
        {
            _gate = gate;
            _inner = inner;
        }

        public void Set(double value)
        {
            lock (_gate) _inner.Set(value);
        }
    }

    sealed class LockedHistogram : IHistogram
    {
        readonly object _gate;
        readonly IHistogram _inner;

        public LockedHistogram(object gate, IHistogram inner)
        {
            _gate = gate;
            _inner = inner;
        }

        public void Observe(double value)
        {
            Observe(value, null);
        }

        public void Observe(double value, IReadOnlyDictionary<string, object> attrs)
        {
            lock (_gate) _inner.Observe(value, attrs);
        }
    }

    public struct SyncFlags
    {
        public bool Bootstrap;
        public bool Flush;
    }

    public sealed class ConfigApi
    {
        readonly WardxClient _client;

        internal ConfigApi(WardxClient client)
        {
            _client = client;
        }

        public T Get<T>(string key, T fallback, string subjectId = null)
        {
            return _client.ConfigGet(key, fallback, subjectId);
        }
    }

    public sealed class ExperimentApi
    {
        readonly WardxClient _client;

        internal ExperimentApi(WardxClient client)
        {
            _client = client;
        }

        public void Goal(string name, string subjectId = null, object value = null)
        {
            _client.Goal(name, subjectId, value);
        }
    }

    public sealed class LogApi
    {
        readonly WardxClient _client;

        internal LogApi(WardxClient client)
        {
            _client = client;
        }

        public void Debug(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _client.WriteLog("debug", message, attrs);
        }

        public void Info(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _client.WriteLog("info", message, attrs);
        }

        public void Warn(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _client.WriteLog("warn", message, attrs);
        }

        public void Error(string message, IReadOnlyDictionary<string, object> attrs = null)
        {
            _client.WriteLog("error", message, attrs);
        }
    }
}
