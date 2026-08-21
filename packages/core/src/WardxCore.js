import { MetricsRegistry } from './metrics/MetricsRegistry.js';
import { EventBuffer } from './buffers/EventBuffer.js';
import { LogBuffer } from './buffers/LogBuffer.js';
import { ConfigStore } from './config/ConfigStore.js';
import { ExperimentResolver } from './config/ExperimentResolver.js';
import { FrameBuilder } from './frame/FrameBuilder.js';
import { InternalMetrics } from './internal/InternalMetrics.js';
import { NOOP_COUNTER } from './metrics/Counter.js';
import { NOOP_GAUGE } from './metrics/Gauge.js';
import { NOOP_HISTOGRAM } from './metrics/Histogram.js';
import { startTimer } from './metrics/Timer.js';
import { emit } from './trace/emit.js';
import { wrapCounter, wrapGauge, wrapHistogram } from './trace/wrap.js';

export class WardxCore {
  constructor(settings) {
    this.settings = settings;
    this.stopped = false;
    this._tracer = settings.tracer ?? null;
    this._wrappers = this._tracer ? new WeakMap() : null;
    this.internal = new InternalMetrics();
    this.metrics = new MetricsRegistry({
      maxSeriesPerMetric: settings.maxSeriesPerMetric,
      maxDimensionKeys: settings.maxDimensionKeys,
      maxDimensionValueLength: settings.maxDimensionValueLength,
      defaultHistogramBuckets: settings.histogramBuckets,
      onCardinalityDropped: () => {
        this.internal.cardinalityDropped += 1;
      }
    });
    this.events = new EventBuffer(settings.maxBufferedEvents);
    this.logs = new LogBuffer(settings.maxBufferedLogs);
    this.configStore = new ConfigStore();
    this.experiments = new ExperimentResolver({
      privacySalt: settings.privacySalt,
      onExposure: (payload) => {
        this.event('experiment.exposure', payload);
      }
    });
    this.seq = 0;
    this.pendingFrames = [];
    this.windowStart = Date.now();
    this.log = {
      debug: (message, attrs) => this._log('debug', message, attrs),
      info: (message, attrs) => this._log('info', message, attrs),
      warn: (message, attrs) => this._log('warn', message, attrs),
      error: (message, attrs) => this._log('error', message, attrs)
    };
  }

  counter(name, dims) {
    return this._wrap(this.metrics.counter(name, dims), NOOP_COUNTER, (series, noop) =>
      wrapCounter(this._tracer, series, noop, name, dims)
    );
  }

  gauge(name, dims) {
    return this._wrap(this.metrics.gauge(name, dims), NOOP_GAUGE, (series, noop) =>
      wrapGauge(this._tracer, series, noop, name, dims)
    );
  }

  histogram(name, a, b) {
    return this._wrap(this.metrics.histogram(name, a, b), NOOP_HISTOGRAM, (series, noop) =>
      wrapHistogram(this._tracer, series, noop, name)
    );
  }

  timer(name, dims) {
    if (this._tracer === null) return this.metrics.timer(name, dims);
    return startTimer((duration, endDims) => {
      const merged = endDims ? { ...(dims || {}), ...endDims } : dims;
      this.histogram(name, merged).observe(duration);
    });
  }

  event(name, attrs) {
    const dropped = !this.events.push(name, attrs);
    if (dropped) this.internal.eventsDropped += 1;
    emit(this._tracer, 'event', { name, attrs: attrs ?? null, dropped });
  }

  _log(level, message, attrs) {
    const dropped = !this.logs.push(level, message, attrs);
    if (dropped) this.internal.logsDropped += 1;
    emit(this._tracer, 'log', { level, message, attrs: attrs ?? null, dropped });
  }

  _wrap(series, noopSentinel, factory) {
    if (this._tracer === null) return series;
    if (series === noopSentinel) return factory(series, true);
    let wrapped = this._wrappers.get(series);
    if (wrapped) return wrapped;
    wrapped = factory(series, false);
    this._wrappers.set(series, wrapped);
    return wrapped;
  }

  configGet(key, fallback, context) {
    if (!this.configStore.has(key)) return fallback;
    const remote = this.configStore.getRaw(key);
    if (!context || context.subjectId === undefined || context.subjectId === null) {
      return remote;
    }
    return this.experiments.resolve(
      key,
      remote,
      context.subjectId,
      this.configStore.experimentsByKey
    );
  }

  experimentGoal(name, context) {
    if (!context || context.subjectId === undefined || context.subjectId === null) {
      throw new Error('experiment.goal requires subjectId');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('experiment.goal requires a metric name');
    }
    const subject = this.experiments.hashSubject(context.subjectId);
    const experiments = this.experiments.relevantExperiments(
      context.subjectId,
      this.configStore.experiments
    );
    const payload = {
      metric: name,
      subject,
      experiments
    };
    if (context.value !== undefined) payload.value = context.value;
    this.event('experiment.goal', payload);
  }

  applyConfig(version, config) {
    this.configStore.applySnapshot({
      version,
      values: config.values,
      experiments: config.experiments
    });
    this.internal.configVersion = version;
  }

  snapshotIfDirty() {
    if (
      !this.metrics.isDirty() &&
      this.events.length === 0 &&
      this.logs.length === 0 &&
      !this.internal.hasCounterActivity()
    ) {
      return null;
    }
    return this.snapshotFrame();
  }

  snapshotFrame() {
    const to = Date.now();
    const from = this.windowStart;
    this.windowStart = to;
    this.internal.eventsBuffered = this.events.length;
    this.internal.logsBuffered = this.logs.length;
    const metrics = this.metrics.snapshotAndReset();
    const events = this.events.swap();
    const logs = this.logs.swap();
    const internal = this.internal.snapshotAndReset();
    const frame = FrameBuilder.build({
      seq: ++this.seq,
      from,
      to,
      metrics,
      events,
      logs,
      internal
    });
    const fitted = FrameBuilder.fitToMaxBytes(frame, this.settings.maxFrameBytes);
    this.internal.logsDropped += fitted.droppedLogs;
    this.internal.eventsDropped += fitted.droppedEvents;
    this.pendingFrames.push(fitted.frame);
    emit(this._tracer, 'frame', {
      seq: fitted.frame.seq,
      from: fitted.frame.from,
      to: fitted.frame.to,
      counters: fitted.frame.metrics.counters.length,
      gauges: fitted.frame.metrics.gauges.length,
      histograms: fitted.frame.metrics.histograms.length,
      events: fitted.frame.events.length,
      logs: fitted.frame.logs.length,
      droppedLogs: fitted.droppedLogs,
      droppedEvents: fitted.droppedEvents
    });
    return fitted;
  }

  takePendingFrames() {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    return frames;
  }
}
