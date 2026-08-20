export class InternalMetrics {
  constructor() {
    this.eventsDropped = 0;
    this.logsDropped = 0;
    this.cardinalityDropped = 0;
    this.framesSent = 0;
    this.framesFailed = 0;
    this.bytesUncompressed = 0;
    this.bytesCompressed = 0;
    this.eventsBuffered = 0;
    this.logsBuffered = 0;
    this.lastSyncMs = 0;
    this.configVersion = 0;
    this.processRssBytes = 0;
  }

  hasCounterActivity() {
    return (
      this.eventsDropped !== 0 ||
      this.logsDropped !== 0 ||
      this.cardinalityDropped !== 0 ||
      this.framesSent !== 0 ||
      this.framesFailed !== 0 ||
      this.bytesUncompressed !== 0 ||
      this.bytesCompressed !== 0
    );
  }

  snapshotAndReset() {
    const snap = {
      eventsDropped: this.eventsDropped,
      logsDropped: this.logsDropped,
      cardinalityDropped: this.cardinalityDropped,
      framesSent: this.framesSent,
      framesFailed: this.framesFailed,
      bytesUncompressed: this.bytesUncompressed,
      bytesCompressed: this.bytesCompressed,
      eventsBuffered: this.eventsBuffered,
      logsBuffered: this.logsBuffered,
      lastSyncMs: this.lastSyncMs,
      configVersion: this.configVersion,
      processRssBytes: this.processRssBytes
    };
    this.eventsDropped = 0;
    this.logsDropped = 0;
    this.cardinalityDropped = 0;
    this.framesSent = 0;
    this.framesFailed = 0;
    this.bytesUncompressed = 0;
    this.bytesCompressed = 0;
    return snap;
  }
}
