import {
  PLATFORM,
  SDK_NAME,
  WardxCore,
  nextSyncDelayMs,
  ulid
} from '@wardx/core';
import { disabledCore } from './disabled.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipBuffer } from './compression/gzip.js';
import { createHttpTransport } from './transport/HttpTransport.js';
import { readProcessRssBytes } from './runtime/processMetrics.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

function copyAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new Error('attributes must be an object');
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (key.length === 0) throw new Error('attributes keys must be non-empty strings');
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`attributes.${key} must be a string, finite number, or boolean`);
    }
  }
  return Object.fromEntries(Object.entries(attributes));
}

export class WardxNode {
  constructor(settings) {
    this.settings = settings;
    this._disabled = settings.enabled === false;
    this._core = this._disabled ? disabledCore : new WardxCore(settings);
    this.log = this._core.log;
    this.config = {
      get: (key, fallback, context) => this._core.configGet(key, fallback, context)
    };
    this.experiment = {
      goal: (name, context) => this._core.experimentGoal(name, context)
    };
    if (this._disabled) return;
    this._attributes = copyAttributes(settings.attributes === undefined ? {} : settings.attributes);
    this._transport = createHttpTransport(settings);
    this._stopped = false;
    this._shutdownPromise = null;
    this._syncChain = Promise.resolve();
    this._queuedSync = null;
    this._instanceId = ulid();
    this._sessionId = ulid();
    this._aggregateTimer = setInterval(() => {
      this._core.recordProcessRss(readProcessRssBytes());
      this._core.snapshotIfDirty();
    }, settings.aggregateIntervalMs);
    this._aggregateTimer.unref();
    this._scheduleSync();
    this._enqueueSync({ bootstrap: true });
  }

  retentionActivity(userId) {
    this._core.retentionActivity(userId);
  }

  identify(subjectId) {
    this._core.identify(subjectId);
  }

  setAttributes(attributes) {
    if (this._disabled) return;
    this._attributes = copyAttributes(attributes);
  }

  counter(name, dims) {
    return this._core.counter(name, dims);
  }

  gauge(name, dims) {
    return this._core.gauge(name, dims);
  }

  histogram(name, a, b) {
    return this._core.histogram(name, a, b);
  }

  distinct(name, dims) {
    return this._core.distinct(name, dims);
  }

  timer(name, dims) {
    return this._core.timer(name, dims);
  }

  event(name, attrs) {
    this._core.event(name, attrs);
  }

  flush() {
    if (this._disabled) return Promise.resolve();
    return this._enqueueSync({ flush: true });
  }

  shutdown() {
    if (this._disabled) return Promise.resolve();
    if (this._shutdownPromise === null) this._shutdownPromise = this._shutdown();
    return this._shutdownPromise;
  }

  async _shutdown() {
    this._stopped = true;
    clearInterval(this._aggregateTimer);
    if (this._syncTimer) clearTimeout(this._syncTimer);
    await this._enqueueSync({ flush: true });
    this._transport.close();
  }

  _scheduleSync() {
    if (this._stopped) return;
    const delay = nextSyncDelayMs(this.settings);
    this._syncTimer = setTimeout(() => {
      this._enqueueSync({}).finally(() => this._scheduleSync());
    }, delay);
    this._syncTimer.unref();
  }

  _enqueueSync(flags) {
    if (this._queuedSync && !this._queuedSync.bootstrap) {
      this._queuedSync.flush ||= flags.flush;
      return this._syncChain;
    }
    this._queuedSync = flags;
    const run = () => {
      if (this._queuedSync === flags) this._queuedSync = null;
      return this._syncOnce(flags);
    };
    this._syncChain = this._syncChain.then(run, run);
    return this._syncChain;
  }

  async _syncOnce(flags) {
    if (this._stopped && !flags.flush) return;
    try {
      await this._syncOnceInner(flags);
    } catch {
      this._core.recordSyncError();
    }
  }

  async _syncOnceInner(flags) {
    if (flags.flush || flags.bootstrap) {
      this._core.recordProcessRss(readProcessRssBytes());
      this._core.snapshotIfDirty();
    }
    const frames = this._core.takePendingFrames();
    if (!flags.bootstrap && !flags.flush && frames.length === 0) return;
    const envelope = this._core.syncEnvelope({
      project: this.settings.project,
      sdk: {
        name: SDK_NAME,
        version: pkg.version
      },
      client: {
        instanceId: this._instanceId,
        sessionId: this._sessionId,
        role: this.settings.role,
        appVersion: this.settings.appVersion,
        environment: this.settings.environment,
        platform: PLATFORM,
        attributes: this._attributes
      }
    }, frames);
    const json = JSON.stringify(envelope);
    const compressed = await gzipBuffer(json);
    const bytesUncompressed = Buffer.byteLength(json);
    const bytesCompressed = compressed.length;
    this._core.recordSyncBytes(bytesUncompressed, bytesCompressed);
    const started = performance.now();
    const phase = flags.bootstrap ? 'bootstrap' : flags.flush ? 'flush' : 'tick';
    const trace = { phase, frames: frames.length, bytesUncompressed, bytesCompressed };
    try {
      const result = await this._transport.post(compressed);
      const ms = performance.now() - started;
      this._core.recordSyncResult({ ok: result.ok, frames: frames.length, ms });
      if (!result.ok) {
        this._traceSync({ ...trace, ms, ok: false, status: result.status });
        return;
      }
      this._core.applySyncResponse(result.json);
      this._traceSync({
        ...trace,
        ms,
        ok: true,
        status: result.status,
        configVersion: this._core.configVersion,
        appliedConfig: Boolean(result.json && result.json.config)
      });
    } catch {
      const ms = performance.now() - started;
      this._core.recordSyncResult({ ok: false, frames: frames.length, ms });
      this._traceSync({ ...trace, ms, ok: false });
    }
  }

  _traceSync(record) {
    const tracer = this.settings.tracer;
    if (tracer == null) return;
    const fn = tracer.sync;
    if (typeof fn === 'function') fn.call(tracer, record);
  }
}
