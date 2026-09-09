export const PROTOCOL_VERSION = 1;
export const SDK_NAME = 'wardx-node';
export const PLATFORM = 'node';

export const INTERNAL = {
  eventsBuffered: 'wardx.internal.events_buffered',
  logsBuffered: 'wardx.internal.logs_buffered',
  eventsDropped: 'wardx.internal.events_dropped',
  logsDropped: 'wardx.internal.logs_dropped',
  cardinalityDropped: 'wardx.internal.cardinality_dropped',
  framesSent: 'wardx.internal.frames_sent',
  framesFailed: 'wardx.internal.frames_failed',
  bytesUncompressed: 'wardx.internal.bytes_uncompressed',
  bytesCompressed: 'wardx.internal.bytes_compressed',
  lastSyncMs: 'wardx.internal.last_sync_ms',
  configVersion: 'wardx.internal.config_version',
  processRssBytes: 'wardx.internal.process_rss_bytes',
  frameRowsDropped: 'wardx.internal.frame_rows_dropped'
};

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export const LOG_RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export const UINT32 = 4294967296;

export const REQUIRED_CREATE_KEYS = [
  'endpoint',
  'projectKey',
  'project',
  'role',
  'appVersion',
  'environment',
  'privacySalt'
];

export const REQUIRED_SDK_DEFAULT_KEYS = [
  'aggregateIntervalMs',
  'syncIntervalMs',
  'syncJitterMin',
  'syncJitterMax',
  'maxBufferedEvents',
  'maxBufferedLogs',
  'maxFrameBytes',
  'maxPendingFrames',
  'maxSeriesPerMetric',
  'maxDimensionKeys',
  'maxDimensionValueLength',
  'experimentStateMaxSubjects',
  'httpTimeoutMs',
  'histogramBuckets'
];
