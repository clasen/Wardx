namespace Wardx
{
    public sealed class InternalMetrics
    {
        public double EventsDropped;
        public double LogsDropped;
        public double CardinalityDropped;
        public double FramesSent;
        public double FramesFailed;
        public double BytesUncompressed;
        public double BytesCompressed;
        public double EventsBuffered;
        public double LogsBuffered;
        public double LastSyncMs;
        public double ConfigVersion;
        public double ProcessRssBytes;

        public bool HasCounterActivity()
        {
            return EventsDropped != 0
                || LogsDropped != 0
                || CardinalityDropped != 0
                || FramesSent != 0
                || FramesFailed != 0
                || BytesUncompressed != 0
                || BytesCompressed != 0;
        }

        public InternalSnapshot SnapshotAndReset()
        {
            var snap = new InternalSnapshot
            {
                EventsDropped = EventsDropped,
                LogsDropped = LogsDropped,
                CardinalityDropped = CardinalityDropped,
                FramesSent = FramesSent,
                FramesFailed = FramesFailed,
                BytesUncompressed = BytesUncompressed,
                BytesCompressed = BytesCompressed,
                EventsBuffered = EventsBuffered,
                LogsBuffered = LogsBuffered,
                LastSyncMs = LastSyncMs,
                ConfigVersion = ConfigVersion,
                ProcessRssBytes = ProcessRssBytes
            };
            EventsDropped = 0;
            LogsDropped = 0;
            CardinalityDropped = 0;
            FramesSent = 0;
            FramesFailed = 0;
            BytesUncompressed = 0;
            BytesCompressed = 0;
            return snap;
        }
    }

    public sealed class InternalSnapshot
    {
        public double EventsDropped;
        public double LogsDropped;
        public double CardinalityDropped;
        public double FramesSent;
        public double FramesFailed;
        public double BytesUncompressed;
        public double BytesCompressed;
        public double EventsBuffered;
        public double LogsBuffered;
        public double LastSyncMs;
        public double ConfigVersion;
        public double ProcessRssBytes;
    }
}
