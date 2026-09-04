function attrsMatch(rowAttrs, filterAttrs) {
  if (filterAttrs === undefined || filterAttrs === null) return true;
  if (!rowAttrs || typeof rowAttrs !== 'object') return false;
  for (const [key, value] of Object.entries(filterAttrs)) {
    if (rowAttrs[key] !== value) return false;
  }
  return true;
}

export class RecentEvents {
  constructor(max) {
    this.max = max;
    this.buf = new Array(max);
    this.next = 0;
    this.size = 0;
  }

  ingest(envelope, inspectEvents) {
    if (!Array.isArray(inspectEvents)) throw new Error('inspectEvents must be an array');
    const instanceId = envelope.client.instanceId;
    const role = envelope.client.role;
    for (const frame of envelope.frames) {
      for (const row of frame.events) {
        if (inspectEvents.includes(row[1])) this._push(row, instanceId, role);
      }
    }
  }

  _push(row, instanceId, role) {
    if (!Array.isArray(row) || row.length !== 3) return;
    const ts = row[0];
    const name = row[1];
    const attrs = row[2];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    if (typeof name !== 'string' || name.length === 0) return;
    if (attrs !== null && (typeof attrs !== 'object' || Array.isArray(attrs))) return;
    this.buf[this.next] = {
      ts,
      name,
      attrs: structuredClone(attrs),
      instanceId,
      role
    };
    this.next = (this.next + 1) % this.max;
    if (this.size < this.max) this.size++;
  }

  query(filter = {}) {
    const rows = [];
    for (let offset = 1; offset <= this.size; offset++) {
      const index = (this.next - offset + this.max) % this.max;
      const row = this.buf[index];
      if (filter.name && row.name !== filter.name) continue;
      if (filter.role && row.role !== filter.role) continue;
      if (!attrsMatch(row.attrs, filter.attrs)) continue;
      rows.push(row);
    }
    rows.sort((left, right) => right.ts - left.ts);
    return filter.limit === undefined || filter.limit === null
      ? rows
      : rows.slice(0, filter.limit);
  }
}
