using System;
using System.Collections.Generic;
using System.IO;

namespace Wardx
{
    /// <summary>
    /// Counters and distincts persisted to disk until the server acknowledges them. They survive
    /// failed syncs and process restarts, and are reported in the window of the sync that delivers
    /// them. Delivery is at-least-once: a lost acknowledgement re-sends the flight.
    /// Mutations only mark the state dirty; SaveIfDirty writes it, so disk writes stay bounded by
    /// the aggregate interval. maxRetainedSeries bounds memory and file size.
    /// </summary>
    sealed class RetainedMetrics
    {
        const int FormatVersion = 1;

        readonly string _path;
        readonly MetricsRegistry _pending;
        readonly int _maxSeries;
        readonly HashSet<object> _series = new HashSet<object>();
        readonly Action _onCardinalityDropped;
        MetricSnapshot _flight;
        bool _dirty;

        public RetainedMetrics(Settings settings, Action onCardinalityDropped)
        {
            _path = settings.RetainedPath;
            _maxSeries = settings.MaxRetainedSeries;
            _onCardinalityDropped = onCardinalityDropped;
            _pending = new MetricsRegistry(
                settings.MaxSeriesPerMetric,
                settings.MaxDimensionKeys,
                settings.MaxDimensionValueLength,
                settings.HistogramBuckets,
                onCardinalityDropped,
                settings.PrivacySalt
            );
            Load();
        }

        public ICounter Counter(string name, IReadOnlyDictionary<string, object> dims)
        {
            var series = _pending.Counter(name, dims);
            if (ReferenceEquals(series, NoopCounter.Instance) || !Admit(series)) return NoopCounter.Instance;
            return new RetainedCounter(this, series);
        }

        public IDistinct Distinct(string name, IReadOnlyDictionary<string, object> dims)
        {
            var series = _pending.Distinct(name, dims);
            if (ReferenceEquals(series, NoopDistinct.Instance) || !Admit(series)) return NoopDistinct.Instance;
            return new RetainedDistinct(this, series);
        }

        bool Admit(object series)
        {
            if (_series.Contains(series)) return true;
            if (_series.Count >= _maxSeries)
            {
                _onCardinalityDropped();
                return false;
            }
            _series.Add(series);
            return true;
        }

        public void SaveIfDirty()
        {
            if (_dirty) Save();
        }

        /// <summary>Moves pending values into the flight, or returns null when nothing is pending or a flight is open.</summary>
        public MetricSnapshot BeginFlight()
        {
            if (_flight != null || !_pending.IsDirty()) return null;
            _flight = _pending.SnapshotAndReset();
            Save();
            return _flight;
        }

        public void CommitFlight()
        {
            if (_flight == null) throw new InvalidOperationException("no retained flight to commit");
            _flight = null;
            Save();
        }

        public void AbortFlight()
        {
            if (_flight == null) throw new InvalidOperationException("no retained flight to abort");
            Restore(_flight);
            _flight = null;
            Save();
        }

        void Restore(MetricSnapshot snapshot)
        {
            foreach (var row in snapshot.Counters)
            {
                var series = _pending.Counter(row.Name, row.Dims);
                if (!ReferenceEquals(series, NoopCounter.Instance) && Admit(series)) series.Add(row.Value);
            }
            foreach (var row in snapshot.Distincts)
            {
                if (_pending.Distinct(row.Name, row.Dims) is HyperLogLog series && Admit(series)) series.Merge(row.Body);
            }
        }

        void Save()
        {
            _dirty = false;
            var state = new Dictionary<string, object>
            {
                ["version"] = FormatVersion,
                ["pending"] = SnapshotWire(_pending.Snapshot()),
                ["flight"] = _flight != null ? SnapshotWire(_flight) : null
            };
            var temp = _path + ".tmp";
            try
            {
                var directory = Path.GetDirectoryName(Path.GetFullPath(_path));
                Directory.CreateDirectory(directory);
                File.WriteAllText(temp, Json.Stringify(state));
                if (File.Exists(_path)) File.Replace(temp, _path, null);
                else File.Move(temp, _path);
            }
            catch (Exception error) when (error is IOException || error is UnauthorizedAccessException)
            {
                // The values stay in memory; the next SaveIfDirty retries the write.
                _dirty = true;
            }
        }

        void Load()
        {
            if (!File.Exists(_path)) return;
            try
            {
                var state = Json.Parse(File.ReadAllText(_path));
                if (Field(state, "version").NumberValue != FormatVersion) throw new FormatException("unsupported retained metrics version");
                // An unacknowledged flight may or may not have reached the server; re-send it.
                Restore(ParseSnapshot(Field(state, "pending")));
                var flight = Field(state, "flight");
                if (!flight.IsNull) Restore(ParseSnapshot(flight));
            }
            catch (Exception error) when (error is FormatException || error is ArgumentException)
            {
                // A corrupt file cannot be recovered; start empty instead of failing the host app.
                _pending.SnapshotAndReset();
            }
            Save();
        }

        static Dictionary<string, object> SnapshotWire(MetricSnapshot snapshot)
        {
            var counters = new List<object>(snapshot.Counters.Count);
            foreach (var row in snapshot.Counters) counters.Add(Frame.ToWire(row));
            var distincts = new List<object>(snapshot.Distincts.Count);
            foreach (var row in snapshot.Distincts) distincts.Add(Frame.ToWire(row));
            return new Dictionary<string, object> { ["counters"] = counters, ["distincts"] = distincts };
        }

        static MetricSnapshot ParseSnapshot(JsonNode node)
        {
            var counters = new List<CounterSample>();
            foreach (var row in Rows(node, "counters"))
            {
                counters.Add(new CounterSample(Text(row[0]), ParseDims(row[1]), Of(row[2], JsonNode.Kind.Number).NumberValue));
            }
            var distincts = new List<DistinctSample>();
            foreach (var row in Rows(node, "distincts"))
            {
                var body = Of(row[2], JsonNode.Kind.Object);
                distincts.Add(new DistinctSample(
                    Text(row[0]),
                    ParseDims(row[1]),
                    new HllBody((int)Of(Field(body, "precision"), JsonNode.Kind.Number).NumberValue, Text(Field(body, "registers")))
                ));
            }
            return new MetricSnapshot(counters, new List<GaugeSample>(), new List<HistogramSample>(), distincts);
        }

        static IEnumerable<List<JsonNode>> Rows(JsonNode snapshot, string key)
        {
            foreach (var row in Of(Field(snapshot, key), JsonNode.Kind.Array).ArrayValue)
            {
                var cells = Of(row, JsonNode.Kind.Array).ArrayValue;
                if (cells.Count != 3) throw new FormatException("retained metric rows must have 3 cells");
                yield return cells;
            }
        }

        static JsonNode Field(JsonNode node, string key)
        {
            return Of(node, JsonNode.Kind.Object)[key] ?? throw new FormatException("retained metrics are missing " + key);
        }

        static JsonNode Of(JsonNode node, JsonNode.Kind kind)
        {
            if (node.Type != kind) throw new FormatException("retained metrics expected " + kind);
            return node;
        }

        static string Text(JsonNode node)
        {
            return Of(node, JsonNode.Kind.String).StringValue;
        }

        static IReadOnlyDictionary<string, object> ParseDims(JsonNode node)
        {
            return node.IsNull ? null : Of(node, JsonNode.Kind.Object).ObjectNative();
        }

        sealed class RetainedCounter : ICounter
        {
            readonly RetainedMetrics _owner;
            readonly ICounter _series;

            public RetainedCounter(RetainedMetrics owner, ICounter series)
            {
                _owner = owner;
                _series = series;
            }

            public void Inc()
            {
                Add(1);
            }

            public void Add(double n)
            {
                _series.Add(n);
                _owner._dirty = true;
            }
        }

        sealed class RetainedDistinct : IDistinct
        {
            readonly RetainedMetrics _owner;
            readonly IDistinct _series;

            public RetainedDistinct(RetainedMetrics owner, IDistinct series)
            {
                _owner = owner;
                _series = series;
            }

            public void Add(string identifier)
            {
                _series.Add(identifier);
                _owner._dirty = true;
            }
        }
    }
}
