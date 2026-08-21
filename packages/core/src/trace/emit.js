export function emit(tracer, hook, record) {
  if (tracer == null) return;
  const fn = tracer[hook];
  if (typeof fn === 'function') fn.call(tracer, record);
}
