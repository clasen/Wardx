using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Wardx
{
    public sealed class MetricsRegistry
    {
        readonly int _maxSeriesPerMetric;
        readonly int _maxDimensionKeys;
        readonly int _maxDimensionValueLength;
        readonly double[] _defaultHistogramBuckets;
        readonly Action _onCardinalityDropped;
        readonly Dictionary<string, Dictionary<string, Counter>> _countersByName = new Dictionary<string, Dictionary<string, Counter>>();
        readonly Dictionary<string, Dictionary<string, Gauge>> _gaugesByName = new Dictionary<string, Dictionary<string, Gauge>>();
        readonly Dictionary<string, Dictionary<string, Histogram>> _histogramsByName = new Dictionary<string, Dictionary<string, Histogram>>();
        readonly HashSet<string> _rejected = new HashSet<string>();

        public MetricsRegistry(
            int maxSeriesPerMetric,
            int maxDimensionKeys,
            int maxDimensionValueLength,
            double[] defaultHistogramBuckets,
            Action onCardinalityDropped)
        {
            _maxSeriesPerMetric = maxSeriesPerMetric;
            _maxDimensionKeys = maxDimensionKeys;
            _maxDimensionValueLength = maxDimensionValueLength;
            _defaultHistogramBuckets = defaultHistogramBuckets;
            _onCardinalityDropped = onCardinalityDropped;
        }

        public ICounter Counter(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            var series = Series(_countersByName, 'c', name, dims, resolved => new Counter(name, resolved));
            return (ICounter)series ?? NoopCounter.Instance;
        }

        public IGauge Gauge(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            var series = Series(_gaugesByName, 'g', name, dims, resolved => new Gauge(name, resolved));
            return (IGauge)series ?? NoopGauge.Instance;
        }

        public IHistogram Histogram(string name, IReadOnlyDictionary<string, object> dims = null, double[] buckets = null)
        {
            var bounds = buckets ?? _defaultHistogramBuckets;
            AssertBuckets(bounds);
            var series = Series(_histogramsByName, 'h', name, dims, resolved =>
                new Histogram(name, resolved, CloneBuckets(bounds), _maxDimensionKeys, _maxDimensionValueLength));
            if (series == null) return NoopHistogram.Instance;
            var histogram = (Histogram)series;
            if (!BoundsEqual(histogram.Bounds, bounds))
            {
                throw new InvalidOperationException("histogram " + name + " buckets cannot change for an existing series");
            }
            return histogram;
        }

        public TimerToken Timer(string name, IReadOnlyDictionary<string, object> dims = null)
        {
            var histogram = Histogram(name, dims);
            var start = Stopwatch.GetTimestamp();
            return new TimerToken(endDims =>
            {
                var duration = (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
                if (endDims != null)
                {
                    Histogram(name, Dimensions.Merge(dims, endDims)).Observe(duration);
                    return;
                }
                histogram.Observe(duration);
            });
        }

        public MetricSnapshot SnapshotAndReset()
        {
            var counters = new List<CounterSample>();
            foreach (var byKey in _countersByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Value != 0)
                    {
                        counters.Add(new CounterSample(series.Name, series.Dims, series.Value));
                        series.Value = 0;
                    }
                }
            }
            var gauges = new List<GaugeSample>();
            foreach (var byKey in _gaugesByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Dirty)
                    {
                        gauges.Add(new GaugeSample(series.Name, series.Dims, series.Value, series.Timestamp));
                        series.Dirty = false;
                    }
                }
            }
            var histograms = new List<HistogramSample>();
            foreach (var byKey in _histogramsByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Count > 0)
                    {
                        histograms.Add(new HistogramSample(series.Name, series.Dims, series.Snapshot()));
                        series.Reset();
                    }
                }
            }
            return new MetricSnapshot(counters, gauges, histograms);
        }

        public bool IsDirty()
        {
            foreach (var byKey in _countersByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Value != 0) return true;
                }
            }
            foreach (var byKey in _gaugesByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Dirty) return true;
                }
            }
            foreach (var byKey in _histogramsByName.Values)
            {
                foreach (var series in byKey.Values)
                {
                    if (series.Count > 0) return true;
                }
            }
            return false;
        }

        object Series<T>(
            Dictionary<string, Dictionary<string, T>> kindMap,
            char kindPrefix,
            string name,
            IReadOnlyDictionary<string, object> dims,
            Func<IReadOnlyDictionary<string, object>, T> factory)
        {
            Dimensions.AssertMetricName(name);
            var checkedDims = Dimensions.Validate(dims, _maxDimensionKeys, _maxDimensionValueLength);
            var key = Dimensions.DimKey(checkedDims.IsOk ? checkedDims.Dims : dims);
            var rejectKey = kindPrefix + "\0" + name + "\0" + key;
            if (_rejected.Contains(rejectKey)) return null;
            if (!checkedDims.IsOk)
            {
                _rejected.Add(rejectKey);
                _onCardinalityDropped();
                return null;
            }
            if (!kindMap.TryGetValue(name, out var byKey))
            {
                byKey = new Dictionary<string, T>();
                kindMap[name] = byKey;
            }
            if (byKey.TryGetValue(key, out var series)) return series;
            if (byKey.Count >= _maxSeriesPerMetric)
            {
                _rejected.Add(rejectKey);
                _onCardinalityDropped();
                return null;
            }
            series = factory(checkedDims.Dims);
            byKey[key] = series;
            return series;
        }

        static void AssertBuckets(double[] buckets)
        {
            if (buckets == null || buckets.Length == 0)
            {
                throw new ArgumentException("histogram buckets must be a non-empty array");
            }
            var prev = double.NegativeInfinity;
            for (int i = 0; i < buckets.Length; i++)
            {
                var bound = buckets[i];
                if (double.IsNaN(bound) || double.IsInfinity(bound) || bound <= prev)
                {
                    throw new ArgumentException("histogram buckets must be strictly increasing finite numbers");
                }
                prev = bound;
            }
        }

        static bool BoundsEqual(double[] a, double[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i]) return false;
            }
            return true;
        }

        static double[] CloneBuckets(double[] buckets)
        {
            var copy = new double[buckets.Length];
            Array.Copy(buckets, copy, buckets.Length);
            return copy;
        }
    }

    public sealed class MetricSnapshot
    {
        public readonly List<CounterSample> Counters;
        public readonly List<GaugeSample> Gauges;
        public readonly List<HistogramSample> Histograms;

        public MetricSnapshot(List<CounterSample> counters, List<GaugeSample> gauges, List<HistogramSample> histograms)
        {
            Counters = counters;
            Gauges = gauges;
            Histograms = histograms;
        }
    }

    public readonly struct CounterSample
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public readonly double Value;

        public CounterSample(string name, IReadOnlyDictionary<string, object> dims, double value)
        {
            Name = name;
            Dims = dims;
            Value = value;
        }
    }

    public readonly struct GaugeSample
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public readonly double Value;
        public readonly long Timestamp;

        public GaugeSample(string name, IReadOnlyDictionary<string, object> dims, double value, long timestamp)
        {
            Name = name;
            Dims = dims;
            Value = value;
            Timestamp = timestamp;
        }
    }

    public readonly struct HistogramSample
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public readonly HistogramBody Body;

        public HistogramSample(string name, IReadOnlyDictionary<string, object> dims, HistogramBody body)
        {
            Name = name;
            Dims = dims;
            Body = body;
        }
    }
}
