const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function attrsMatch(rowAttrs, filterAttrs) {
  if (filterAttrs === undefined || filterAttrs === null) return true;
  if (!rowAttrs || typeof rowAttrs !== 'object') return false;
  for (const key of Object.keys(filterAttrs)) {
    if (rowAttrs[key] !== filterAttrs[key]) return false;
  }
  return true;
}

export class RecentLogs {
  constructor(max) {
    this.max = max;
    this.buf = [];
  }

  ingest(envelope) {
    const instanceId = envelope.client.instanceId;
    const role = envelope.client.role;
    for (const frame of envelope.frames) {
      for (const row of frame.logs) {
        this._push(row, instanceId, role);
      }
    }
  }

  _push(row, instanceId, role) {
    if (!Array.isArray(row) || row.length < 3) return;
    const ts = row[0];
    const level = row[1];
    const message = row[2];
    if (!LOG_LEVELS.has(level)) return;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (typeof message !== 'string' || message.length === 0) return;
    this.buf.push({
      ts,
      level,
      message,
      attrs: row[3] ?? null,
      instanceId,
      role
    });
    while (this.buf.length > this.max) this.buf.shift();
  }

  query(filter = {}) {
    const out = [];
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const row = this.buf[i];
      if (filter.level && row.level !== filter.level) continue;
      if (filter.message && row.message !== filter.message) continue;
      if (filter.role && row.role !== filter.role) continue;
      if (!attrsMatch(row.attrs, filter.attrs)) continue;
      out.push(row);
      if (filter.limit !== undefined && filter.limit !== null && out.length >= filter.limit) break;
    }
    return out;
  }
}
