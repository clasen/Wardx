export class EventBuffer {
  constructor(maxBufferedEvents) {
    if (!Number.isFinite(maxBufferedEvents) || maxBufferedEvents < 1) {
      throw new Error('maxBufferedEvents must be >= 1');
    }
    this.max = maxBufferedEvents;
    this.buf = [];
  }

  get length() {
    return this.buf.length;
  }

  push(name, attrs) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('event name must be a non-empty string');
    }
    if (this.buf.length >= this.max) return false;
    this.buf.push([Date.now(), name, attrs ?? null]);
    return true;
  }

  swap() {
    const sealed = this.buf;
    this.buf = [];
    return sealed;
  }
}
