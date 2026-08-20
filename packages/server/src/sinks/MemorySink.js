export class MemorySink {
  constructor({ memorySinkMaxEnvelopes }) {
    this.max = memorySinkMaxEnvelopes;
    this.envelopes = [];
    this.frameCount = 0;
  }

  ingest(envelope) {
    this.envelopes.push(envelope);
    this.frameCount += envelope.frames.length;
    if (this.envelopes.length > this.max) {
      const dropped = this.envelopes.shift();
      this.frameCount -= dropped.frames.length;
    }
  }
}
