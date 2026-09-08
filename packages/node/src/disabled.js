const noop = () => {};
const counter = Object.freeze({ inc: noop, add: noop });
const gauge = Object.freeze({ set: noop });
const histogram = Object.freeze({ observe: noop });
const distinct = Object.freeze({ add: noop });

export const disabledCore = Object.freeze({
  counter: () => counter,
  gauge: () => gauge,
  histogram: () => histogram,
  distinct: () => distinct,
  timer: () => noop,
  event: noop,
  retentionActivity: noop,
  identify: noop,
  log: Object.freeze({ debug: noop, info: noop, warn: noop, error: noop }),
  configGet: (key, fallback) => fallback,
  experimentGoal: noop
});
