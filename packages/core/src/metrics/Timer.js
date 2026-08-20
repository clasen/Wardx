export function startTimer(observe) {
  const start = performance.now();
  return function endTimer(dims) {
    observe(performance.now() - start, dims);
  };
}
