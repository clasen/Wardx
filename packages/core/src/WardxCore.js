import { MetricsRegistry } from './metrics/MetricsRegistry.js';
import { EventBuffer } from './buffers/EventBuffer.js';
import { LogBuffer } from './buffers/LogBuffer.js';
import { ConfigStore } from './config/ConfigStore.js';
import { ExperimentResolver } from './config/ExperimentResolver.js';
import { subjectHash } from './config/hash.js';
import { FrameBuilder } from './frame/FrameBuilder.js';
import { InternalMetrics } from './internal/InternalMetrics.js';
import { NOOP_COUNTER } from './metrics/Counter.js';
import { NOOP_GAUGE } from './metrics/Gauge.js';
import { NOOP_HISTOGRAM } from './metrics/Histogram.js';
import { NOOP_DISTINCT } from './metrics/HyperLogLog.js';
import { startTimer } from './metrics/Timer.js';
import { emit } from './trace/emit.js';
import { wrapCounter, wrapDistinct, wrapGauge, wrapHistogram } from './trace/wrap.js';

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
      privacySalt: settings.privacySalt,
      onCardinalityDropped: () => {
        this.internal.cardinalityDropped += 1;
      }
    });
    this.events = new EventBuffer(settings.maxBufferedEvents);
    this.logs = new LogBuffer(settings.maxBufferedLogs);
    this.configStore = new ConfigStore();
    this.experiments = new ExperimentResolver({
      privacySalt: settings.privacySalt,
      stateMaxSubjects: settings.experimentStateMaxSubjects,
      onExposure: (payload) => {
        this.event('experiment.exposure', payload);
      }
    });
    this.seq = 0;
    this.pendingFrames = [];
    this.windowStart = Date.now();
    this._subjectId = null;
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

  distinct(name, dims) {
    return this._wrap(this.metrics.distinct(name, dims), NOOP_DISTINCT, (series, noop) =>
      wrapDistinct(this._tracer, series, noop, name, dims)
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

  retentionActivity(userId) {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('retentionActivity requires a non-empty userId');
    }
    const salt = this.settings.privacySalt;
    if (typeof salt !== 'string' || salt.trim().length === 0) {
      throw new Error('retentionActivity requires a non-empty privacySalt');
    }
    this.event('retention.activity', {
      subject: subjectHash(salt, userId),
      salt: subjectHash(salt, 'wardx.retention.identity')
    });
  }

  identify(subjectId) {
    if (subjectId === undefined || subjectId === null) {
      this._subjectId = null;
      return;
    }
    if (typeof subjectId !== 'string' || subjectId.length === 0) {
      throw new Error('identify requires a non-empty subjectId');
    }
    this._subjectId = subjectId;
  }

  _subjectIdFrom(context) {
    if (context && context.subjectId !== undefined && context.subjectId !== null) {
      return context.subjectId;
    }
    return this._subjectId;
  }

  configGet(key, fallback, context) {
    if (!this.configStore.has(key)) return fallback;
    const remote = this.configStore.getRaw(key);
    const subjectId = this._subjectIdFrom(context);
    if (subjectId === undefined || subjectId === null) return remote;
    return this.experiments.resolve(
      key,
      remote,
      subjectId,
      this.configStore.experimentsByKey
    );
  }

  experimentGoal(name, context) {
    const subjectId = this._subjectIdFrom(context);
    if (subjectId === undefined || subjectId === null) {
      throw new Error('experiment.goal requires subjectId');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('experiment.goal requires a metric name');
    }
    const subject = this.experiments.hashSubject(subjectId);
    const assignment = this.experiments.exposedAssignmentForGoal(subjectId, name);
    if (assignment === null) return;
    const payload = {
      metric: name,
      subject,
      experiments: [{ experiment: assignment.experiment, variant: assignment.variant }]
    };
    if (context && context.value !== undefined) payload.value = context.value;
    this.event('experiment.goal', payload);
  }

  applyConfig(version, config) {
    this.configStore.applySnapshot({
      version,
      values: config.values,
      experiments: config.experiments
    });
    this.experiments.applySnapshot(this.configStore.experiments);
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
      seq: this.seq + 1,
      from,
      to,
      metrics,
      events,
      logs,
      internal
    });
    const batch = FrameBuilder.splitToMaxBytes(frame, this.settings.maxFrameBytes);
    this.seq = batch.frames.at(-1).seq;
    this.pendingFrames.push(...batch.frames);
    for (let i = 0; i < batch.frames.length; i++) {
      const physical = batch.frames[i];
      emit(this._tracer, 'frame', {
        seq: physical.seq,
        from: physical.from,
        to: physical.to,
        counters: physical.metrics.counters.length,
        gauges: physical.metrics.gauges.length,
        histograms: physical.metrics.histograms.length,
        distincts: physical.metrics.distincts?.length || 0,
        events: physical.events.length,
        logs: physical.logs.length,
        droppedLogs: i === 0 ? batch.droppedLogs : 0,
        droppedEvents: i === 0 ? batch.droppedEvents : 0,
        droppedRows: i === 0 ? batch.droppedRows : 0
      });
    }
    return batch;
  }

  takePendingFrames() {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    return frames;
  }
}
