using System.Collections.Generic;

namespace Wardx
{
    public interface ITracer
    {
        void Measure(MeasureRecord record);
        void Event(EventRecord record);
        void Log(LogRecord record);
        void Frame(FrameRecord record);
        void Sync(SyncRecord record);
    }

    public abstract class TracerBase : ITracer
    {
        public virtual void Measure(MeasureRecord record) { }
        public virtual void Event(EventRecord record) { }
        public virtual void Log(LogRecord record) { }
        public virtual void Frame(FrameRecord record) { }
        public virtual void Sync(SyncRecord record) { }
    }

    public sealed class MeasureRecord
    {
        public string Type;
        public string Name;
        public IReadOnlyDictionary<string, object> Dims;
        public string Op;
        public double Value;
        public IReadOnlyDictionary<string, object> Attrs;
        public bool Noop;
    }

    public sealed class EventRecord
    {
        public string Name;
        public IReadOnlyDictionary<string, object> Attrs;
        public bool Dropped;
    }

    public sealed class LogRecord
    {
        public string Level;
        public string Message;
        public IReadOnlyDictionary<string, object> Attrs;
        public bool Dropped;
    }

    public sealed class FrameRecord
    {
        public int Seq;
        public long From;
        public long To;
        public int Counters;
        public int Gauges;
        public int Histograms;
        public int Events;
        public int Logs;
        public int DroppedLogs;
        public int DroppedEvents;
    }

    public sealed class SyncRecord
    {
        public string Phase;
        public int Frames;
        public int BytesUncompressed;
        public int BytesCompressed;
        public double Ms;
        public bool Ok;
        public int? Status;
        public int? ConfigVersion;
        public bool AppliedConfig;
    }

    static class TracerEmit
    {
        public static void Measure(ITracer tracer, MeasureRecord record)
        {
            if (tracer != null) tracer.Measure(record);
        }

        public static void Event(ITracer tracer, EventRecord record)
        {
            if (tracer != null) tracer.Event(record);
        }

        public static void Log(ITracer tracer, LogRecord record)
        {
            if (tracer != null) tracer.Log(record);
        }

        public static void Frame(ITracer tracer, FrameRecord record)
        {
            if (tracer != null) tracer.Frame(record);
        }

        public static void Sync(ITracer tracer, SyncRecord record)
        {
            if (tracer != null) tracer.Sync(record);
        }
    }

    sealed class TracedCounter : ICounter
    {
        readonly ICounter _inner;
        readonly ITracer _tracer;
        readonly string _name;
        readonly IReadOnlyDictionary<string, object> _dims;
        readonly bool _noop;

        public TracedCounter(ICounter inner, ITracer tracer, string name, IReadOnlyDictionary<string, object> dims, bool noop)
        {
            _inner = inner;
            _tracer = tracer;
            _name = name;
            _dims = dims;
            _noop = noop;
        }

        public void Inc()
        {
            _inner.Inc();
            TracerEmit.Measure(_tracer, new MeasureRecord
            {
                Type = "counter",
                Name = _name,
                Dims = _dims,
                Op = "inc",
                Value = 1,
                Noop = _noop
            });
        }

        public void Add(double n)
        {
            _inner.Add(n);
            TracerEmit.Measure(_tracer, new MeasureRecord
            {
                Type = "counter",
                Name = _name,
                Dims = _dims,
                Op = "add",
                Value = n,
                Noop = _noop
            });
        }
    }

    sealed class TracedGauge : IGauge
    {
        readonly IGauge _inner;
        readonly ITracer _tracer;
        readonly string _name;
        readonly IReadOnlyDictionary<string, object> _dims;
        readonly bool _noop;

        public TracedGauge(IGauge inner, ITracer tracer, string name, IReadOnlyDictionary<string, object> dims, bool noop)
        {
            _inner = inner;
            _tracer = tracer;
            _name = name;
            _dims = dims;
            _noop = noop;
        }

        public void Set(double value)
        {
            _inner.Set(value);
            TracerEmit.Measure(_tracer, new MeasureRecord
            {
                Type = "gauge",
                Name = _name,
                Dims = _dims,
                Op = "set",
                Value = value,
                Noop = _noop
            });
        }
    }

    sealed class TracedHistogram : IHistogram
    {
        readonly IHistogram _inner;
        readonly ITracer _tracer;
        readonly string _name;
        readonly IReadOnlyDictionary<string, object> _dims;
        readonly bool _noop;

        public TracedHistogram(IHistogram inner, ITracer tracer, string name, IReadOnlyDictionary<string, object> dims, bool noop)
        {
            _inner = inner;
            _tracer = tracer;
            _name = name;
            _dims = dims;
            _noop = noop;
        }

        public void Observe(double value)
        {
            Observe(value, null);
        }

        public void Observe(double value, IReadOnlyDictionary<string, object> attrs)
        {
            _inner.Observe(value, attrs);
            TracerEmit.Measure(_tracer, new MeasureRecord
            {
                Type = "histogram",
                Name = _name,
                Dims = _dims,
                Op = "observe",
                Value = value,
                Attrs = attrs,
                Noop = _noop
            });
        }
    }
}
