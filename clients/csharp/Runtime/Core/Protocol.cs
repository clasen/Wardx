namespace Wardx
{
    public static class Protocol
    {
        public const int Version = 1;

        public const string InternalPrefix = "wardx.internal.";

        public static class Internal
        {
            public const string EventsBuffered = "wardx.internal.events_buffered";
            public const string LogsBuffered = "wardx.internal.logs_buffered";
            public const string EventsDropped = "wardx.internal.events_dropped";
            public const string LogsDropped = "wardx.internal.logs_dropped";
            public const string CardinalityDropped = "wardx.internal.cardinality_dropped";
            public const string FramesSent = "wardx.internal.frames_sent";
            public const string FramesFailed = "wardx.internal.frames_failed";
            public const string BytesUncompressed = "wardx.internal.bytes_uncompressed";
            public const string BytesCompressed = "wardx.internal.bytes_compressed";
            public const string LastSyncMs = "wardx.internal.last_sync_ms";
            public const string ConfigVersion = "wardx.internal.config_version";
            public const string ProcessRssBytes = "wardx.internal.process_rss_bytes";
            public const string FrameRowsDropped = "wardx.internal.frame_rows_dropped";
        }

        public static readonly string[] RequiredCreateKeys =
        {
            "endpoint",
            "projectKey",
            "project",
            "role",
            "appVersion",
            "environment"
        };
    }

    public enum LogLevel
    {
        Debug = 0,
        Info = 1,
        Warn = 2,
        Error = 3
    }

    public static class LogLevels
    {
        public static bool TryParse(string level, out LogLevel parsed)
        {
            if (level == "debug") { parsed = LogLevel.Debug; return true; }
            if (level == "info") { parsed = LogLevel.Info; return true; }
            if (level == "warn") { parsed = LogLevel.Warn; return true; }
            if (level == "error") { parsed = LogLevel.Error; return true; }
            parsed = default;
            return false;
        }

        public static string ToWire(LogLevel level)
        {
            switch (level)
            {
                case LogLevel.Debug: return "debug";
                case LogLevel.Info: return "info";
                case LogLevel.Warn: return "warn";
                case LogLevel.Error: return "error";
                default: throw new System.ArgumentOutOfRangeException(nameof(level));
            }
        }

        public static int Rank(string level)
        {
            if (!TryParse(level, out var parsed)) return int.MaxValue;
            return (int)parsed;
        }
    }
}
