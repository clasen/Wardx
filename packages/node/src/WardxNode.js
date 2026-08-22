import {
  PLATFORM,
  PROTOCOL_VERSION,
  SDK_NAME,
  WardxCore,
  nextSyncDelayMs,
  ulid
} from '@wardx/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipBuffer } from './compression/gzip.js';
import { createHttpTransport } from './transport/HttpTransport.js';
import { readProcessRssBytes } from './runtime/processMetrics.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

export class WardxNode {
  constructor(settings) {
    this.settings = settings;
    this._core = new WardxCore(settings);
    this._transport = createHttpTransport(settings);
    this._stopped = false;
    this._syncChain = Promise.resolve();
    this._instanceId = ulid();
    this._sessionId = ulid();
    this.log = this._core.log;
    this.config = {
      get: (key, fallback, context) => this._core.configGet(key, fallback, context)
    };
    this.experiment = {
      goal: (name, context) => this._core.experimentGoal(name, context)
    };
    this._aggregateTimer = setInterval(() => {
      this._core.internal.processRssBytes = readProcessRssBytes();
      this._core.snapshotIfDirty();
    }, settings.aggregateIntervalMs);
    this._aggregateTimer.unref();
    this._scheduleSync();
    this._enqueueSync({ bootstrap: true });
  }

  identify(subjectId) {
    this._core.identify(subjectId);
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

  timer(name, dims) {
    return this._core.timer(name, dims);
  }

  event(name, attrs) {
    this._core.event(name, attrs);
  }

  flush() {
    return this._enqueueSync({ flush: true });
  }

  async shutdown() {
    if (this._stopped) return;
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
    this._syncChain = this._syncChain.then(() => this._syncOnce(flags), () => this._syncOnce(flags));
    return this._syncChain;
  }

  async _syncOnce(flags) {
    if (this._stopped && !flags.flush) return;
    try {
      await this._syncOnceInner(flags);
    } catch {
      this._core.internal.framesFailed += 1;
    }
  }

  async _syncOnceInner(flags) {
    if (flags.flush || flags.bootstrap) {
      this._core.internal.processRssBytes = readProcessRssBytes();
      this._core.snapshotIfDirty();
    }
    const frames = this._core.takePendingFrames();
    if (!flags.bootstrap && frames.length === 0) return;
    const envelope = {
      protocol: PROTOCOL_VERSION,
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
        platform: PLATFORM
      },
      configVersion: this._core.configStore.version,
      frames
    };
    const json = JSON.stringify(envelope);
    const compressed = gzipBuffer(json);
    const bytesUncompressed = Buffer.byteLength(json);
    const bytesCompressed = compressed.length;
    this._core.internal.bytesUncompressed += bytesUncompressed;
    this._core.internal.bytesCompressed += bytesCompressed;
    const started = performance.now();
    const phase = flags.bootstrap ? 'bootstrap' : flags.flush ? 'flush' : 'tick';
    try {
      const result = await this._transport.post(compressed);
      this._core.internal.lastSyncMs = performance.now() - started;
      if (!result.ok) {
        this._core.internal.framesFailed += Math.max(frames.length, 1);
        this._traceSync({
          phase,
          frames: frames.length,
          bytesUncompressed,
          bytesCompressed,
          ms: this._core.internal.lastSyncMs,
          ok: false,
          status: result.status
        });
        return;
      }
      this._core.internal.framesSent += frames.length;
      this._applyResponse(result.json);
      this._traceSync({
        phase,
        frames: frames.length,
        bytesUncompressed,
        bytesCompressed,
        ms: this._core.internal.lastSyncMs,
        ok: true,
        status: result.status,
        configVersion: this._core.configStore.version,
        appliedConfig: Boolean(result.json && result.json.config)
      });
    } catch {
      this._core.internal.lastSyncMs = performance.now() - started;
      this._core.internal.framesFailed += Math.max(frames.length, 1);
      this._traceSync({
        phase,
        frames: frames.length,
        bytesUncompressed,
        bytesCompressed,
        ms: this._core.internal.lastSyncMs,
        ok: false
      });
    }
  }

  _traceSync(record) {
    const tracer = this.settings.tracer;
    if (tracer == null) return;
    const fn = tracer.sync;
    if (typeof fn === 'function') fn.call(tracer, record);
  }

  _applyResponse(json) {
    if (!json || json.ok !== true) return;
    if (typeof json.configVersion === 'number') {
      this._core.internal.configVersion = json.configVersion;
    }
    if (json.config) {
      this._core.applyConfig(json.configVersion, json.config);
    }
  }
}
