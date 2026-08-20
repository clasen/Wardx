import { MetricsRegistry } from './metrics/MetricsRegistry.js';
import { EventBuffer } from './buffers/EventBuffer.js';
import { LogBuffer } from './buffers/LogBuffer.js';
import { ConfigStore } from './config/ConfigStore.js';
import { ExperimentResolver } from './config/ExperimentResolver.js';
import { FrameBuilder } from './frame/FrameBuilder.js';
import { InternalMetrics } from './internal/InternalMetrics.js';

export class WardxCore {
  constructor(settings) {
    this.settings = settings;
    this.stopped = false;
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
    return this.metrics.counter(name, dims);
  }

  gauge(name, dims) {
    return this.metrics.gauge(name, dims);
  }

  histogram(name, a, b) {
    return this.metrics.histogram(name, a, b);
  }

  timer(name, dims) {
    return this.metrics.timer(name, dims);
  }

  event(name, attrs) {
    if (!this.events.push(name, attrs)) this.internal.eventsDropped += 1;
  }

  _log(level, message, attrs) {
    if (!this.logs.push(level, message, attrs)) this.internal.logsDropped += 1;
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
    return fitted;
  }

  takePendingFrames() {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    return frames;
  }
}
