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
        public List<EventSample> Events = new List<EventSample>();
        public List<LogSample> Logs = new List<LogSample>();

        public Dictionary<string, object> ToWire()
        {
            return new Dictionary<string, object>
            {
                ["seq"] = Seq,
                ["from"] = From,
                ["to"] = To,
                ["metrics"] = new Dictionary<string, object>
                {
                    ["counters"] = CounterRows(),
                    ["gauges"] = GaugeRows(),
                    ["histograms"] = HistogramRows()
                },
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

    public sealed class FittedFrame
    {
        public Frame Frame;
        public string Json;
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

        public static FittedFrame FitToMaxBytes(Frame frame, int maxFrameBytes)
        {
            var json = Json.Stringify(frame.ToWire());
            var bytes = System.Text.Encoding.UTF8.GetByteCount(json);
            if (bytes <= maxFrameBytes)
            {
                return new FittedFrame { Frame = frame, Json = json, DroppedLogs = 0, DroppedEvents = 0 };
            }

            var droppedLogs = 0;
            var droppedEvents = 0;

            if (frame.Logs.Count > 0)
            {
                var dropOrder = LogDropOrder(frame.Logs);
                var original = frame.Logs;
                var k = LeastDrops(dropOrder.Length, mid =>
                {
                    frame.Logs = LogsWithoutFirstK(original, dropOrder, mid);
                    return Json.Utf8ByteLength(frame.ToWire()) <= maxFrameBytes;
                });
                frame.Logs = LogsWithoutFirstK(original, dropOrder, k);
                droppedLogs = k;
                json = Json.Stringify(frame.ToWire());
                bytes = System.Text.Encoding.UTF8.GetByteCount(json);
                if (bytes <= maxFrameBytes)
                {
                    return new FittedFrame { Frame = frame, Json = json, DroppedLogs = droppedLogs, DroppedEvents = droppedEvents };
                }
            }

            if (frame.Events.Count > 0)
            {
                var original = frame.Events;
                var k = LeastDrops(original.Count, mid =>
                {
                    frame.Events = Slice(original, original.Count - mid);
                    return Json.Utf8ByteLength(frame.ToWire()) <= maxFrameBytes;
                });
                frame.Events = Slice(original, original.Count - k);
                droppedEvents = k;
                json = Json.Stringify(frame.ToWire());
                bytes = System.Text.Encoding.UTF8.GetByteCount(json);
                if (bytes <= maxFrameBytes)
                {
                    return new FittedFrame { Frame = frame, Json = json, DroppedLogs = droppedLogs, DroppedEvents = droppedEvents };
                }
            }

            if (bytes > maxFrameBytes && frame.Histograms.Count > 0)
            {
                frame.Histograms = new List<HistogramSample>();
                json = Json.Stringify(frame.ToWire());
                bytes = System.Text.Encoding.UTF8.GetByteCount(json);
            }
            if (bytes > maxFrameBytes)
            {
                var kept = new List<GaugeSample>();
                foreach (var row in frame.Gauges)
                {
                    if (row.Name != null && row.Name.StartsWith(Protocol.InternalPrefix)) kept.Add(row);
                }
                frame.Gauges = kept;
                json = Json.Stringify(frame.ToWire());
            }
            return new FittedFrame { Frame = frame, Json = json, DroppedLogs = droppedLogs, DroppedEvents = droppedEvents };
        }

        static int[] LogDropOrder(List<LogSample> logs)
        {
            var order = new int[logs.Count];
            for (int i = 0; i < order.Length; i++) order[i] = i;
            System.Array.Sort(order, (a, b) =>
            {
                var rankA = LogLevels.Rank(logs[a].Level);
                var rankB = LogLevels.Rank(logs[b].Level);
                if (rankA != rankB) return rankA.CompareTo(rankB);
                return a.CompareTo(b);
            });
            return order;
        }

        static List<LogSample> LogsWithoutFirstK(List<LogSample> logs, int[] dropOrder, int k)
        {
            if (k <= 0) return logs;
            if (k >= logs.Count) return new List<LogSample>();
            var drop = new HashSet<int>();
            for (int i = 0; i < k; i++) drop.Add(dropOrder[i]);
            var kept = new List<LogSample>(logs.Count - k);
            for (int i = 0; i < logs.Count; i++)
            {
                if (!drop.Contains(i)) kept.Add(logs[i]);
            }
            return kept;
        }

        static List<EventSample> Slice(List<EventSample> events, int count)
        {
            if (count <= 0) return new List<EventSample>();
            if (count >= events.Count) return events;
            var kept = new List<EventSample>(count);
            for (int i = 0; i < count; i++) kept.Add(events[i]);
            return kept;
        }

        static int LeastDrops(int maxDrop, System.Func<int, bool> fits)
        {
            if (maxDrop == 0) return 0;
            if (!fits(maxDrop)) return maxDrop;
            var lo = 0;
            var hi = maxDrop;
            while (lo < hi)
            {
                var mid = (lo + hi) >> 1;
                if (fits(mid)) hi = mid;
                else lo = mid + 1;
            }
            return lo;
        }
    }
}
