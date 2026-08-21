using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace Wardx
{
    public sealed class ConsoleTracer : TracerBase
    {
        readonly TextWriter _stream;

        public ConsoleTracer(TextWriter stream = null)
        {
            _stream = stream ?? Console.Error;
        }

        public override void Measure(MeasureRecord record)
        {
            var noop = record.Noop ? " noop" : "";
            var attrs = FormatDims(record.Attrs);
            Write("measure", record.Type.PadRight(10) + " " + record.Name + FormatDims(record.Dims) + "  " + record.Op + " " + record.Value + attrs + noop);
        }

        public override void Event(EventRecord record)
        {
            var dropped = record.Dropped ? " dropped" : "";
            Write("event", record.Name + FormatDims(record.Attrs) + dropped);
        }

        public override void Log(LogRecord record)
        {
            var dropped = record.Dropped ? " dropped" : "";
            Write("log", record.Level + " " + record.Message + FormatDims(record.Attrs) + dropped);
        }

        public override void Frame(FrameRecord record)
        {
            var extra = "";
            if (record.DroppedLogs != 0) extra += "  droppedLogs=" + record.DroppedLogs;
            if (record.DroppedEvents != 0) extra += "  droppedEvents=" + record.DroppedEvents;
            Write(
                "frame",
                "seq=" + record.Seq +
                "  counters=" + record.Counters +
                " gauges=" + record.Gauges +
                " histograms=" + record.Histograms +
                " events=" + record.Events +
                " logs=" + record.Logs + extra
            );
        }

        public override void Sync(SyncRecord record)
        {
            var result = record.Ok ? "ok" : "fail";
            var config = record.ConfigVersion.HasValue ? " config=" + record.ConfigVersion.Value : "";
            var applied = record.AppliedConfig ? " +config" : "";
            var status = record.Status.HasValue ? " status=" + record.Status.Value : "";
            Write(
                "sync",
                record.Phase +
                " frames=" + record.Frames +
                " gzip=" + record.BytesCompressed + "B " +
                record.Ms.ToString("0.0", CultureInfo.InvariantCulture) + "ms " +
                result + status + config + applied
            );
        }

        void Write(string kind, string rest)
        {
            _stream.WriteLine("wardx  " + kind.PadRight(10) + " " + rest);
        }

        static string FormatDims(System.Collections.Generic.IReadOnlyDictionary<string, object> dims)
        {
            if (dims == null || dims.Count == 0) return "";
            var sb = new StringBuilder(" ");
            var first = true;
            foreach (var pair in dims)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(pair.Key);
                sb.Append('=');
                sb.Append(pair.Value);
            }
            return sb.ToString();
        }
    }
}
