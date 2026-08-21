using System;
using System.Collections.Generic;

namespace Wardx
{
    public sealed class Histogram : IHistogram
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public readonly double[] Bounds;
        readonly int _maxDimensionKeys;
        readonly int _maxDimensionValueLength;
        readonly bool _hasLimits;
        readonly int[] _counts;
        public int Count;
        public double Sum;
        public double Min = double.PositiveInfinity;
        public double Max = double.NegativeInfinity;
        public HistogramExemplar Exemplar;

        public Histogram(string name, IReadOnlyDictionary<string, object> dims, double[] bounds, int maxDimensionKeys, int maxDimensionValueLength)
        {
            Name = name;
            Dims = dims;
            Bounds = bounds;
            _maxDimensionKeys = maxDimensionKeys;
            _maxDimensionValueLength = maxDimensionValueLength;
            _hasLimits = true;
            _counts = new int[bounds.Length];
        }

        public void Observe(double value)
        {
            Observe(value, null);
        }

        public void Observe(double value, IReadOnlyDictionary<string, object> attrs)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new ArgumentException("histogram.observe requires a finite number");
            }
            var isMax = value >= Max;
            Count += 1;
            Sum += value;
            if (value < Min) Min = value;
            if (isMax)
            {
                Max = value;
                Exemplar = ExemplarFrom(value, attrs);
            }
            for (int i = 0; i < Bounds.Length; i++)
            {
                if (value <= Bounds[i])
                {
                    _counts[i] += 1;
                    return;
                }
            }
        }

        HistogramExemplar ExemplarFrom(double value, IReadOnlyDictionary<string, object> attrs)
        {
            if (attrs == null) return null;
            if (!_hasLimits)
            {
                throw new InvalidOperationException("histogram.observe attrs require dimension limits");
            }
            var checkedDims = Dimensions.Validate(attrs, _maxDimensionKeys, _maxDimensionValueLength);
            if (!checkedDims.IsOk || checkedDims.Dims == null) return null;
            return new HistogramExemplar(value, checkedDims.Dims);
        }

        public HistogramBody Snapshot()
        {
            var buckets = new HistogramBucket[Bounds.Length];
            for (int i = 0; i < Bounds.Length; i++)
            {
                buckets[i] = new HistogramBucket(Bounds[i], _counts[i]);
            }
            return new HistogramBody
            {
                Count = Count,
                Sum = Sum,
                Min = Min,
                Max = Max,
                Buckets = buckets,
                Exemplar = Exemplar
            };
        }

        public void Reset()
        {
            Array.Clear(_counts, 0, _counts.Length);
            Count = 0;
            Sum = 0;
            Min = double.PositiveInfinity;
            Max = double.NegativeInfinity;
            Exemplar = null;
        }
    }

    public sealed class NoopHistogram : IHistogram
    {
        public static readonly NoopHistogram Instance = new NoopHistogram();
        public void Observe(double value) { }
        public void Observe(double value, IReadOnlyDictionary<string, object> attrs) { }
    }

    public sealed class HistogramExemplar
    {
        public readonly double Value;
        public readonly IReadOnlyDictionary<string, object> Attrs;

        public HistogramExemplar(double value, IReadOnlyDictionary<string, object> attrs)
        {
            Value = value;
            Attrs = attrs;
        }
    }

    public struct HistogramBucket
    {
        public readonly double Bound;
        public readonly int Count;

        public HistogramBucket(double bound, int count)
        {
            Bound = bound;
            Count = count;
        }
    }

    public sealed class HistogramBody
    {
        public int Count;
        public double Sum;
        public double Min;
        public double Max;
        public HistogramBucket[] Buckets;
        public HistogramExemplar Exemplar;
    }

    public sealed class TimerToken
    {
        readonly Action<IReadOnlyDictionary<string, object>> _stop;
        bool _stopped;

        public TimerToken(Action<IReadOnlyDictionary<string, object>> stop)
        {
            _stop = stop;
        }

        public void Stop()
        {
            Stop(null);
        }

        public void Stop(IReadOnlyDictionary<string, object> endDims)
        {
            if (_stopped) return;
            _stopped = true;
            _stop(endDims);
        }
    }
}
