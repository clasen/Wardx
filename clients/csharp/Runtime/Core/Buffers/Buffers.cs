using System;
using System.Collections.Generic;

namespace Wardx
{
    public sealed class EventBuffer
    {
        readonly int _max;
        List<EventSample> _buf = new List<EventSample>();

        public EventBuffer(int maxBufferedEvents)
        {
            if (maxBufferedEvents < 1)
            {
                throw new ArgumentException("maxBufferedEvents must be >= 1");
            }
            _max = maxBufferedEvents;
        }

        public int Length => _buf.Count;

        public bool Push(string name, IReadOnlyDictionary<string, object> attrs)
        {
            if (string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("event name must be a non-empty string");
            }
            if (_buf.Count >= _max) return false;
            _buf.Add(new EventSample(Clock.UnixMs(), name, EnumNames.Normalize(attrs)));
            return true;
        }

        public List<EventSample> Swap()
        {
            var sealedBuf = _buf;
            _buf = new List<EventSample>();
            return sealedBuf;
        }
    }

    public readonly struct EventSample
    {
        public readonly long Time;
        public readonly string Name;
        public readonly IReadOnlyDictionary<string, object> Attrs;

        public EventSample(long time, string name, IReadOnlyDictionary<string, object> attrs)
        {
            Time = time;
            Name = name;
            Attrs = attrs;
        }
    }

    public sealed class LogBuffer
    {
        readonly int _max;
        List<LogSample> _buf = new List<LogSample>();

        public LogBuffer(int maxBufferedLogs)
        {
            if (maxBufferedLogs < 1)
            {
                throw new ArgumentException("maxBufferedLogs must be >= 1");
            }
            _max = maxBufferedLogs;
        }

        public int Length => _buf.Count;

        public bool Push(string level, string message, IReadOnlyDictionary<string, object> attrs)
        {
            if (!LogLevels.TryParse(level, out var parsed))
            {
                throw new ArgumentException("invalid log level: " + level);
            }
            if (string.IsNullOrEmpty(message))
            {
                throw new ArgumentException("log message must be a non-empty string");
            }
            var entry = new LogSample(Clock.UnixMs(), level, message, EnumNames.Normalize(attrs));
            if (_buf.Count < _max)
            {
                _buf.Add(entry);
                return true;
            }
            var incomingRank = (int)parsed;
            var victim = -1;
            var victimRank = incomingRank;
            for (int i = 0; i < _buf.Count; i++)
            {
                var rank = LogLevels.Rank(_buf[i].Level);
                if (rank < victimRank)
                {
                    victimRank = rank;
                    victim = i;
                }
            }
            if (victim == -1) return false;
            _buf[victim] = entry;
            return false;
        }

        public List<LogSample> Swap()
        {
            var sealedBuf = _buf;
            _buf = new List<LogSample>();
            return sealedBuf;
        }
    }

    public readonly struct LogSample
    {
        public readonly long Time;
        public readonly string Level;
        public readonly string Message;
        public readonly IReadOnlyDictionary<string, object> Attrs;

        public LogSample(long time, string level, string message, IReadOnlyDictionary<string, object> attrs)
        {
            Time = time;
            Level = level;
            Message = message;
            Attrs = attrs;
        }
    }
}
