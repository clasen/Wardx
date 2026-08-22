namespace Wardx
{
    /// <summary>
    /// Operational defaults. Same values as packages/core/defaults.json.
    /// </summary>
    public static class SdkDefaults
    {
        public const int AggregateIntervalMs = 1000;
        public const int SyncIntervalMs = 15000;
        public const double SyncJitterMin = 0.85;
        public const double SyncJitterMax = 1.15;
        public const int MaxBufferedEvents = 5000;
        public const int MaxBufferedLogs = 2000;
        public const int MaxFrameBytes = 524288;
        public const int MaxSeriesPerMetric = 1000;
        public const int MaxDimensionKeys = 8;
        public const int MaxDimensionValueLength = 64;
        public const int HttpTimeoutMs = 10000;

        public static readonly double[] HistogramBuckets = { 10, 25, 50, 100, 250, 500, 1000 };

        public const string Version = "0.1.4";
    }
}
