using System.Collections.Generic;

namespace Wardx
{
    public sealed class Frame
    {
        public int Seq;
        public long From;
        public long To;
        public List<CounterSample> Counters = new List<CounterSample>();
        public List<GaugeSample> Gauges = new List<GaugeSample>();
        public List<HistogramSample> Histograms = new List<HistogramSample>();
        public List<DistinctSample> Distincts = new List<DistinctSample>();
        public List<EventSample> Events = new List<EventSample>();
        public List<LogSample> Logs = new List<LogSample>();

        public Dictionary<string, object> ToWire()
        {
            var metrics = new Dictionary<string, object>
            {
                ["counters"] = CounterRows(),
                ["gauges"] = GaugeRows(),
                ["histograms"] = HistogramRows()
            };
            if (Distincts.Count > 0) metrics["distincts"] = DistinctRows();
            return new Dictionary<string, object>
            {
                ["seq"] = Seq,
                ["from"] = From,
                ["to"] = To,
                ["metrics"] = metrics,
                ["events"] = EventRows(),
                ["logs"] = LogRows()
            };
        }

        List<object> CounterRows()
        {
            var rows = new List<object>(Counters.Count);
            foreach (var row in Counters)
            {
                rows.Add(new object[] { row.Name, DimsOrNull(row.Dims), row.Value });
            }
            return rows;
        }

        List<object> GaugeRows()
        {
            var rows = new List<object>(Gauges.Count);
            foreach (var row in Gauges)
            {
                rows.Add(new object[] { row.Name, DimsOrNull(row.Dims), row.Value, row.Timestamp });
            }
            return rows;
        }

        List<object> HistogramRows()
        {
            var rows = new List<object>(Histograms.Count);
            foreach (var row in Histograms)
            {
                rows.Add(new object[] { row.Name, DimsOrNull(row.Dims), HistogramWire(row.Body) });
            }
            return rows;
        }

        List<object> DistinctRows()
        {
            var rows = new List<object>(Distincts.Count);
            foreach (var row in Distincts)
            {
                rows.Add(new object[]
                {
                    row.Name,
                    DimsOrNull(row.Dims),
                    new Dictionary<string, object>
                    {
                        ["precision"] = row.Body.Precision,
                        ["registers"] = row.Body.Registers
                    }
                });
            }
            return rows;
        }

        List<object> EventRows()
        {
            var rows = new List<object>(Events.Count);
            foreach (var row in Events)
            {
                rows.Add(new object[] { row.Time, row.Name, AttrsOrNull(row.Attrs) });
            }
            return rows;
        }

        List<object> LogRows()
        {
            var rows = new List<object>(Logs.Count);
            foreach (var row in Logs)
            {
                rows.Add(new object[] { row.Time, row.Level, row.Message, AttrsOrNull(row.Attrs) });
            }
            return rows;
        }

        static Dictionary<string, object> HistogramWire(HistogramBody body)
        {
            var buckets = new List<object>(body.Buckets.Length);
            foreach (var bucket in body.Buckets)
            {
                buckets.Add(new object[] { bucket.Bound, bucket.Count });
            }
            var wire = new Dictionary<string, object>
            {
                ["count"] = body.Count,
                ["sum"] = body.Sum,
                ["min"] = body.Min,
                ["max"] = body.Max,
                ["buckets"] = buckets
            };
            if (body.Exemplar != null)
            {
                wire["exemplar"] = new Dictionary<string, object>
                {
                    ["value"] = body.Exemplar.Value,
                    ["attrs"] = DimsOrNull(body.Exemplar.Attrs)
                };
            }
            return wire;
        }

        static object DimsOrNull(IReadOnlyDictionary<string, object> dims)
        {
            if (dims == null || dims.Count == 0) return null;
            var copy = new Dictionary<string, object>(dims.Count);
            foreach (var pair in dims) copy[pair.Key] = pair.Value;
            return copy;
        }

        static object AttrsOrNull(IReadOnlyDictionary<string, object> attrs)
        {
            return DimsOrNull(attrs);
        }
    }

    public sealed class FrameBatch
    {
        public List<Frame> Frames = new List<Frame>();
        public List<string> Jsons = new List<string>();
        public int DroppedRows;
        public int DroppedCounters;
        public int DroppedGauges;
        public int DroppedHistograms;
        public int DroppedDistincts;
        public int DroppedLogs;
        public int DroppedEvents;
    }

    public static class FrameBuilder
    {
        public static Frame Build(int seq, long from, long to, MetricSnapshot metrics, List<EventSample> events, List<LogSample> logs, InternalSnapshot internalMetrics)
        {
            var frame = new Frame
            {
                Seq = seq,
                From = from,
                To = to,
                Counters = new List<CounterSample>(metrics.Counters),
                Gauges = new List<GaugeSample>(metrics.Gauges),
                Histograms = new List<HistogramSample>(metrics.Histograms),
                Distincts = new List<DistinctSample>(metrics.Distincts),
                Events = events,
                Logs = logs
            };
            MergeInternal(frame, internalMetrics);
            return frame;
        }

        public static void MergeInternal(Frame frame, InternalSnapshot internalMetrics)
        {
            if (internalMetrics.EventsDropped != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.EventsDropped, null, internalMetrics.EventsDropped));
            }
            if (internalMetrics.LogsDropped != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.LogsDropped, null, internalMetrics.LogsDropped));
            }
            if (internalMetrics.CardinalityDropped != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.CardinalityDropped, null, internalMetrics.CardinalityDropped));
            }
            if (internalMetrics.FramesSent != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.FramesSent, null, internalMetrics.FramesSent));
            }
            if (internalMetrics.FramesFailed != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.FramesFailed, null, internalMetrics.FramesFailed));
            }
            if (internalMetrics.BytesUncompressed != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.BytesUncompressed, null, internalMetrics.BytesUncompressed));
            }
            if (internalMetrics.BytesCompressed != 0)
            {
                frame.Counters.Add(new CounterSample(Protocol.Internal.BytesCompressed, null, internalMetrics.BytesCompressed));
            }
            var now = Clock.UnixMs();
            frame.Gauges.Add(new GaugeSample(Protocol.Internal.EventsBuffered, null, internalMetrics.EventsBuffered, now));
            frame.Gauges.Add(new GaugeSample(Protocol.Internal.LogsBuffered, null, internalMetrics.LogsBuffered, now));
            if (internalMetrics.LastSyncMs != 0)
            {
                frame.Gauges.Add(new GaugeSample(Protocol.Internal.LastSyncMs, null, internalMetrics.LastSyncMs, now));
            }
            frame.Gauges.Add(new GaugeSample(Protocol.Internal.ConfigVersion, null, internalMetrics.ConfigVersion, now));
            if (internalMetrics.ProcessRssBytes != 0)
            {
                frame.Gauges.Add(new GaugeSample(Protocol.Internal.ProcessRssBytes, null, internalMetrics.ProcessRssBytes, now));
            }
        }

        public static FrameBatch SplitToMaxBytes(Frame frame, int maxFrameBytes)
        {
            if (maxFrameBytes < 1024)
            {
                throw new System.ArgumentException("maxFrameBytes must be an integer at least 1024");
            }
            var splitter = new FrameSplitter(frame, maxFrameBytes);
            foreach (var row in frame.Counters) splitter.AddCounter(row);
            foreach (var row in frame.Gauges) splitter.AddGauge(row);
            foreach (var row in frame.Histograms) splitter.AddHistogram(row);
            foreach (var row in frame.Distincts) splitter.AddDistinct(row);
            foreach (var row in frame.Events) splitter.AddEvent(row);
            foreach (var row in frame.Logs) splitter.AddLog(row);
            return splitter.Finish();
        }
    }

    sealed class FrameSplitter
    {
        readonly int _startingSeq;
        readonly long _from;
        readonly long _to;
        readonly int _maxFrameBytes;
        readonly FrameBatch _batch = new FrameBatch();
        Frame _current;

        public FrameSplitter(Frame source, int maxFrameBytes)
        {
            _startingSeq = source.Seq;
            _from = source.From;
            _to = source.To;
            _maxFrameBytes = maxFrameBytes;
            _current = EmptyFrame(_startingSeq, _from, _to);
        }

        public void AddCounter(CounterSample row)
        {
            if (!TryAdd(row, frame => frame.Counters)) _batch.DroppedCounters++;
        }

        public void AddGauge(GaugeSample row)
        {
            if (!TryAdd(row, frame => frame.Gauges)) _batch.DroppedGauges++;
        }

        public void AddHistogram(HistogramSample row)
        {
            if (!TryAdd(row, frame => frame.Histograms)) _batch.DroppedHistograms++;
        }

        public void AddDistinct(DistinctSample row)
        {
            if (!TryAdd(row, frame => frame.Distincts)) _batch.DroppedDistincts++;
        }

        public void AddEvent(EventSample row)
        {
            if (!TryAdd(row, frame => frame.Events)) _batch.DroppedEvents++;
        }

        public void AddLog(LogSample row)
        {
            if (!TryAdd(row, frame => frame.Logs)) _batch.DroppedLogs++;
        }

        public FrameBatch Finish()
        {
            _batch.DroppedRows = _batch.DroppedCounters
                + _batch.DroppedGauges
                + _batch.DroppedHistograms
                + _batch.DroppedDistincts
                + _batch.DroppedEvents
                + _batch.DroppedLogs;
            if (_batch.DroppedRows > 0)
            {
                var observable = new CounterSample(
                    Protocol.Internal.FrameRowsDropped,
                    null,
                    _batch.DroppedRows
                );
                if (!TryAdd(observable, frame => frame.Counters))
                {
                    throw new System.InvalidOperationException(
                        "maxFrameBytes cannot contain the frame drop metric"
                    );
                }
            }
            if (_batch.Frames.Count == 0 || RowCount(_current) > 0) FinishCurrent();
            return _batch;
        }

        bool TryAdd<T>(T row, System.Func<Frame, List<T>> collection)
        {
            var rows = collection(_current);
            rows.Add(row);
            if (Measure(_current).Bytes <= _maxFrameBytes) return true;
            rows.RemoveAt(rows.Count - 1);
            if (RowCount(_current) > 0)
            {
                FinishCurrent();
                rows = collection(_current);
                rows.Add(row);
                if (Measure(_current).Bytes <= _maxFrameBytes) return true;
                rows.RemoveAt(rows.Count - 1);
            }
            return false;
        }

        void FinishCurrent()
        {
            var measured = Measure(_current);
            if (measured.Bytes > _maxFrameBytes)
            {
                throw new System.InvalidOperationException("frame splitter produced an oversized frame");
            }
            _batch.Frames.Add(_current);
            _batch.Jsons.Add(measured.Json);
            _current = EmptyFrame(_startingSeq + _batch.Frames.Count, _from, _to);
        }

        static Frame EmptyFrame(int seq, long from, long to)
        {
            return new Frame { Seq = seq, From = from, To = to };
        }

        static int RowCount(Frame frame)
        {
            return frame.Counters.Count
                + frame.Gauges.Count
                + frame.Histograms.Count
                + frame.Distincts.Count
                + frame.Events.Count
                + frame.Logs.Count;
        }

        static FrameMeasurement Measure(Frame frame)
        {
            var json = Json.Stringify(frame.ToWire());
            return new FrameMeasurement
            {
                Json = json,
                Bytes = System.Text.Encoding.UTF8.GetByteCount(json)
            };
        }
    }

    sealed class FrameMeasurement
    {
        public string Json;
        public int Bytes;
    }
}
