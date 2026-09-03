import { emit } from './emit.js';

export function wrapCounter(tracer, series, noop, name, dims) {
  const n = noop ? name : series.name;
  const d = noop ? (dims ?? null) : series.dims;
  return {
    inc() {
      series.inc();
      emit(tracer, 'measure', { type: 'counter', name: n, dims: d, op: 'inc', value: 1, noop });
    },
    add(value) {
      series.add(value);
      emit(tracer, 'measure', { type: 'counter', name: n, dims: d, op: 'add', value, noop });
    }
  };
}

export function wrapGauge(tracer, series, noop, name, dims) {
  const n = noop ? name : series.name;
  const d = noop ? (dims ?? null) : series.dims;
  return {
    set(value) {
      series.set(value);
      emit(tracer, 'measure', { type: 'gauge', name: n, dims: d, op: 'set', value, noop });
    }
  };
}

export function wrapHistogram(tracer, series, noop, name, dims) {
  const n = noop ? name : series.name;
  const d = noop ? (dims ?? null) : series.dims;
  return {
    observe(value, attrs) {
      series.observe(value, attrs);
      emit(tracer, 'measure', {
        type: 'histogram',
        name: n,
        dims: d,
        op: 'observe',
        value,
        attrs: attrs ?? null,
        noop
      });
    }
  };
}

export function wrapDistinct(tracer, series, noop, name, dims) {
  const n = noop ? name : series.name;
  const d = noop ? (dims ?? null) : series.dims;
  return {
    add(identifier) {
      series.add(identifier);
      emit(tracer, 'measure', { type: 'distinct', name: n, dims: d, op: 'add', value: 1, noop });
    }
  };
}
