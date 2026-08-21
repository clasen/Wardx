export function validateEnvelope(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (body.protocol !== 1) return 'protocol must be 1';
  if (typeof body.project !== 'string' || body.project.length === 0) return 'project is required';
  if (!body.sdk || typeof body.sdk !== 'object') return 'sdk is required';
  if (typeof body.sdk.name !== 'string' || typeof body.sdk.version !== 'string') {
    return 'sdk.name and sdk.version are required';
  }
  if (!body.client || typeof body.client !== 'object') return 'client is required';
  if (typeof body.client.instanceId !== 'string' || typeof body.client.sessionId !== 'string') {
    return 'client.instanceId and client.sessionId are required';
  }
  if (typeof body.client.role !== 'string' || body.client.role.length === 0) {
    return 'client.role is required';
  }
  if (body.client.role === '*') return 'client.role cannot be *';
  if (typeof body.configVersion !== 'number' || !Number.isFinite(body.configVersion)) {
    return 'configVersion must be a finite number';
  }
  if (!Array.isArray(body.frames)) return 'frames must be an array';
  for (let i = 0; i < body.frames.length; i++) {
    const frame = body.frames[i];
    if (!frame || typeof frame !== 'object') return `frames[${i}] must be an object`;
    if (typeof frame.seq !== 'number' || !Number.isFinite(frame.seq)) return `frames[${i}].seq is required`;
    if (typeof frame.from !== 'number' || typeof frame.to !== 'number') {
      return `frames[${i}].from and frames[${i}].to are required`;
    }
    if (!frame.metrics || typeof frame.metrics !== 'object') return `frames[${i}].metrics is required`;
    if (!Array.isArray(frame.metrics.counters)) return `frames[${i}].metrics.counters must be an array`;
    if (!Array.isArray(frame.metrics.gauges)) return `frames[${i}].metrics.gauges must be an array`;
    if (!Array.isArray(frame.metrics.histograms)) return `frames[${i}].metrics.histograms must be an array`;
    if (!Array.isArray(frame.events)) return `frames[${i}].events must be an array`;
    if (!Array.isArray(frame.logs)) return `frames[${i}].logs must be an array`;
  }
  return null;
}
