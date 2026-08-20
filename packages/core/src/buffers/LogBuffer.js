import { LOG_RANK } from '../protocol.js';

export class LogBuffer {
  constructor(maxBufferedLogs) {
    if (!Number.isFinite(maxBufferedLogs) || maxBufferedLogs < 1) {
      throw new Error('maxBufferedLogs must be >= 1');
    }
    this.max = maxBufferedLogs;
    this.buf = [];
  }

  get length() {
    return this.buf.length;
  }

  push(level, message, attrs) {
    if (!Object.prototype.hasOwnProperty.call(LOG_RANK, level)) {
      throw new Error(`invalid log level: ${level}`);
    }
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('log message must be a non-empty string');
    }
    const entry = [Date.now(), level, message, attrs ?? null];
    if (this.buf.length < this.max) {
      this.buf.push(entry);
      return true;
    }
    const incomingRank = LOG_RANK[level];
    let victim = -1;
    let victimRank = incomingRank;
    for (let i = 0; i < this.buf.length; i++) {
      const rank = LOG_RANK[this.buf[i][1]];
      if (rank < victimRank) {
        victimRank = rank;
        victim = i;
      }
    }
    if (victim === -1) return false;
    this.buf[victim] = entry;
    return false;
  }

  swap() {
    const sealed = this.buf;
    this.buf = [];
    return sealed;
  }
}
