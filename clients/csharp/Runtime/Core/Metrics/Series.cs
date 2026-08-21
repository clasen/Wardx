using System;
using System.Collections.Generic;

namespace Wardx
{
    public interface ICounter
    {
        void Inc();
        void Add(double n);
    }

    public interface IGauge
    {
        void Set(double value);
    }

    public interface IHistogram
    {
        void Observe(double value);
        void Observe(double value, IReadOnlyDictionary<string, object> attrs);
    }

    public sealed class Counter : ICounter
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public double Value;

        public Counter(string name, IReadOnlyDictionary<string, object> dims)
        {
            Name = name;
            Dims = dims;
            Value = 0;
        }

        public void Inc()
        {
            Value += 1;
        }

        public void Add(double n)
        {
            if (double.IsNaN(n) || double.IsInfinity(n))
            {
                throw new ArgumentException("counter.add requires a finite number");
            }
            Value += n;
        }
    }

    public sealed class NoopCounter : ICounter
    {
        public static readonly NoopCounter Instance = new NoopCounter();
        public void Inc() { }
        public void Add(double n) { }
    }

    public sealed class Gauge : IGauge
    {
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Dims;
        public double Value;
        public long Timestamp;
        public bool Dirty;

        public Gauge(string name, IReadOnlyDictionary<string, object> dims)
        {
            Name = name;
            Dims = dims;
        }

        public void Set(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new ArgumentException("gauge.set requires a finite number");
            }
            Value = value;
            Timestamp = Clock.UnixMs();
            Dirty = true;
        }
    }

    public sealed class NoopGauge : IGauge
    {
        public static readonly NoopGauge Instance = new NoopGauge();
        public void Set(double value) { }
    }
}
