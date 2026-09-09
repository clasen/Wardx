export const PROTOCOL_VERSION: 1;
export const SDK_NAME: 'wardx-node';
export const PLATFORM: 'node';

export const INTERNAL: {
  readonly eventsBuffered: 'wardx.internal.events_buffered';
  readonly logsBuffered: 'wardx.internal.logs_buffered';
  readonly eventsDropped: 'wardx.internal.events_dropped';
  readonly logsDropped: 'wardx.internal.logs_dropped';
  readonly cardinalityDropped: 'wardx.internal.cardinality_dropped';
  readonly framesSent: 'wardx.internal.frames_sent';
  readonly framesFailed: 'wardx.internal.frames_failed';
  readonly bytesUncompressed: 'wardx.internal.bytes_uncompressed';
  readonly bytesCompressed: 'wardx.internal.bytes_compressed';
  readonly lastSyncMs: 'wardx.internal.last_sync_ms';
  readonly configVersion: 'wardx.internal.config_version';
  readonly processRssBytes: 'wardx.internal.process_rss_bytes';
  readonly frameRowsDropped: 'wardx.internal.frame_rows_dropped';
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DimensionValue = string | number | boolean;
export interface Dimensions {
  [name: string]: DimensionValue;
}
export type Attrs = Record<string, unknown>;
export type ConfigValue = string | number | boolean;

export interface HistogramOptions {
  buckets?: number[];
  [dimension: string]: DimensionValue | number[] | undefined;
}

export interface CounterHandle {
  inc(): void;
  add(n: number): void;
}

export interface GaugeHandle {
  set(value: number): void;
}

export interface HistogramHandle {
  observe(value: number, attrs?: Dimensions | null): void;
}

export interface DistinctHandle {
  add(identifier: string): void;
}

export type StopTimer = (dims?: Dimensions | null) => void;

export interface SdkDefaults {
  aggregateIntervalMs: number;
  syncIntervalMs: number;
  syncJitterMin: number;
  syncJitterMax: number;
  maxBufferedEvents: number;
  maxBufferedLogs: number;
  maxFrameBytes: number;
  maxSeriesPerMetric: number;
  maxDimensionKeys: number;
  maxDimensionValueLength: number;
  experimentStateMaxSubjects: number;
  httpTimeoutMs: number;
  histogramBuckets: number[];
}

export interface CreateWardxOptions extends Partial<SdkDefaults> {
  attributes?: Record<string, string | number | boolean>;
  enabled?: boolean;
  endpoint: string;
  projectKey: string;
  project: string;
  role: string;
  appVersion: string;
  environment: string;
  privacySalt: string;
  tracer?: Tracer | null;
}

export interface CoreSettings extends SdkDefaults {
  privacySalt: string;
  endpoint?: string;
  projectKey?: string;
  project?: string;
  role?: string;
  appVersion?: string;
  environment?: string;
  tracer?: Tracer | null;
}

export interface ResolvedSettings extends SdkDefaults {
  attributes?: Record<string, string | number | boolean>;
  enabled?: boolean;
  endpoint: string;
  projectKey: string;
  project: string;
  role: string;
  appVersion: string;
  environment: string;
  privacySalt: string;
  tracer?: Tracer | null;
}

export interface SubjectContext {
  subjectId?: string | null;
}

export interface ExperimentGoalContext extends SubjectContext {
  value?: number;
}

export interface ExperimentVariant {
  key: string;
  weight: number;
  values: Record<string, ConfigValue>;
}

export interface Experiment {
  id: string;
  enabled: boolean;
  allocation: number;
  salt: string;
  goalMetric: string;
  primaryMetric?: string;
  variants: ExperimentVariant[];
}

export interface ConfigSnapshot {
  values?: Record<string, ConfigValue>;
  experiments?: Experiment[];
}

export interface Assignment {
  experiment: string;
  variant: string;
}

export interface ExposurePayload {
  experiment: string;
  variant: string;
  subject: string;
}

export type EventRow = [timestamp: number, name: string, attrs: Attrs | null];
export type LogRow = [timestamp: number, level: LogLevel, message: string, attrs: Attrs | null];
export type CounterRow = [name: string, dims: Dimensions | null, value: number];
export type GaugeRow = [name: string, dims: Dimensions | null, value: number, timestamp: number];
export type HistogramRow = [name: string, dims: Dimensions | null, snapshot: HistogramSnapshot];
export type DistinctRow = [name: string, dims: Dimensions | null, sketch: HllSketch];

export interface HllSketch {
  precision: 9;
  registers: string;
}

export interface HistogramExemplar {
  value: number;
  attrs: Dimensions;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Array<[bound: number, count: number]>;
  exemplar?: HistogramExemplar;
}

export interface MetricsSnapshot {
  counters: CounterRow[];
  gauges: GaugeRow[];
  histograms: HistogramRow[];
  distincts?: DistinctRow[];
}

export interface Frame {
  seq: number;
  from: number;
  to: number;
  metrics: MetricsSnapshot;
  events: EventRow[];
  logs: LogRow[];
}

export interface FrameBatch {
  frames: Frame[];
  jsons: string[];
  droppedRows: number;
  droppedCounters: number;
  droppedGauges: number;
  droppedHistograms: number;
  droppedDistincts: number;
  droppedLogs: number;
  droppedEvents: number;
}

export interface InternalSnapshot {
  eventsDropped: number;
  logsDropped: number;
  cardinalityDropped: number;
  framesSent: number;
  framesFailed: number;
  bytesUncompressed: number;
  bytesCompressed: number;
  eventsBuffered: number;
  logsBuffered: number;
  lastSyncMs: number;
  configVersion: number;
  processRssBytes: number;
}

export interface MeasureTraceRecord {
  type: 'counter' | 'gauge' | 'histogram' | 'distinct';
  name: string;
  dims: Dimensions | null;
  op: 'inc' | 'add' | 'set' | 'observe';
  value: number;
  attrs?: Dimensions | null;
  noop: boolean;
}

export interface EventTraceRecord {
  name: string;
  attrs: Attrs | null;
  dropped: boolean;
}

export interface LogTraceRecord {
  level: LogLevel;
  message: string;
  attrs: Attrs | null;
  dropped: boolean;
}

export interface FrameTraceRecord {
  seq: number;
  from: number;
  to: number;
  counters: number;
  gauges: number;
  histograms: number;
  distincts: number;
  events: number;
  logs: number;
  droppedLogs: number;
  droppedEvents: number;
  droppedRows: number;
}

export interface SyncTraceRecord {
  phase: 'bootstrap' | 'flush' | 'tick';
  frames: number;
  bytesUncompressed: number;
  bytesCompressed: number;
  ms: number;
  ok: boolean;
  status?: number;
  configVersion?: number;
  appliedConfig?: boolean;
}

export interface Tracer {
  measure?(record: MeasureTraceRecord): void;
  event?(record: EventTraceRecord): void;
  log?(record: LogTraceRecord): void;
  frame?(record: FrameTraceRecord): void;
  sync?(record: SyncTraceRecord): void;
}

export interface LogApi {
  debug(message: string, attrs?: Attrs | null): void;
  info(message: string, attrs?: Attrs | null): void;
  warn(message: string, attrs?: Attrs | null): void;
  error(message: string, attrs?: Attrs | null): void;
}

export interface InternalMetricsState extends InternalSnapshot {
  hasCounterActivity(): boolean;
  snapshotAndReset(): InternalSnapshot;
}

export class Counter implements CounterHandle {
  name: string;
  dims: Dimensions | null;
  value: number;
  constructor(name: string, dims?: Dimensions | null);
  inc(): void;
  add(n: number): void;
}

export class Gauge implements GaugeHandle {
  name: string;
  dims: Dimensions | null;
  value: number;
  timestamp: number;
  dirty: boolean;
  constructor(name: string, dims?: Dimensions | null);
  set(value: number): void;
}

export class Histogram implements HistogramHandle {
  name: string;
  dims: Dimensions | null;
  bounds: number[];
  maxDimensionKeys: number | null;
  maxDimensionValueLength: number | null;
  counts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
  exemplar: HistogramExemplar | null;
  constructor(
    name: string,
    dims: Dimensions | null,
    bounds: number[],
    limits?: { maxDimensionKeys: number; maxDimensionValueLength: number } | null
  );
  observe(value: number, attrs?: Dimensions | null): void;
  snapshot(): HistogramSnapshot;
  reset(): void;
}

export class HyperLogLog implements DistinctHandle {
  name: string;
  dims: Dimensions | null;
  privacySalt: string;
  registers: Uint8Array;
  dirty: boolean;
  constructor(name: string, dims: Dimensions | null, privacySalt: string);
  add(identifier: string): void;
  snapshot(): HllSketch;
  reset(): void;
}

export const HLL_PRECISION: 9;
export function encodeHllRegisters(registers: Uint8Array): string;
export function decodeHllRegisters(sketch: HllSketch): Uint8Array;
export function estimateHllRegisters(registers: Uint8Array): number;
export function estimateHyperLogLog(sketch: HllSketch): number;
export function mergeHyperLogLog(left: HllSketch, right: HllSketch): HllSketch;

export interface MetricsRegistryOptions {
  maxSeriesPerMetric: number;
  maxDimensionKeys: number;
  maxDimensionValueLength: number;
  defaultHistogramBuckets: number[];
  privacySalt?: string;
  onCardinalityDropped: () => void;
}

export class MetricsRegistry {
  constructor(options: MetricsRegistryOptions);
  counter(name: string, dims?: Dimensions | null): CounterHandle;
  gauge(name: string, dims?: Dimensions | null): GaugeHandle;
  histogram(name: string, a?: HistogramOptions | null, b?: HistogramOptions | null): HistogramHandle;
  distinct(name: string, dims?: Dimensions | null): DistinctHandle;
  timer(name: string, dims?: Dimensions | null): StopTimer;
  snapshotAndReset(): MetricsSnapshot;
  isDirty(): boolean;
}

export class EventBuffer {
  max: number;
  constructor(maxBufferedEvents: number);
  get length(): number;
  push(name: string, attrs?: Attrs | null): boolean;
  swap(): EventRow[];
}

export class LogBuffer {
  max: number;
  constructor(maxBufferedLogs: number);
  get length(): number;
  push(level: LogLevel, message: string, attrs?: Attrs | null): boolean;
  swap(): LogRow[];
}

export class ConfigStore {
  version: number;
  values: Record<string, ConfigValue>;
  experiments: Experiment[];
  experimentsByKey: Map<string, Experiment[]>;
  applySnapshot(snapshot: { version: number } & ConfigSnapshot): void;
  has(key: string): boolean;
  getRaw(key: string): ConfigValue | undefined;
}

export class ExperimentResolver {
  stateMaxSubjects: number;
  stateBySubject: Map<string, unknown>;
  constructor(options: {
    privacySalt: string;
    stateMaxSubjects: number;
    onExposure: (payload: ExposurePayload) => void;
  });
  hashSubject(subjectId: string): string;
  recordAssignment(subjectId: string, experiment: Experiment, variant: ExperimentVariant): Assignment;
  assignmentsFor(subjectId: string): Assignment[];
  resolve(
    key: string,
    remoteValue: ConfigValue,
    subjectId: string | null | undefined,
    experimentsByKey: Map<string, Experiment[]>
  ): ConfigValue;
  exposedAssignmentForGoal(subjectId: string, goalMetric: string): Assignment | null;
  applySnapshot(experiments: Experiment[]): void;
}

export class FrameBuilder {
  static build(input: {
    seq: number;
    from: number;
    to: number;
    metrics: MetricsSnapshot;
    events: EventRow[];
    logs: LogRow[];
    internal: InternalSnapshot;
  }): Frame;
  static mergeInternal(counters: CounterRow[], gauges: GaugeRow[], internal: InternalSnapshot): void;
  static splitToMaxBytes(frame: Frame, maxFrameBytes: number): FrameBatch;
}

export class WardxCore {
  settings: CoreSettings;
  stopped: boolean;
  internal: InternalMetricsState;
  metrics: MetricsRegistry;
  events: EventBuffer;
  logs: LogBuffer;
  configStore: ConfigStore;
  experiments: ExperimentResolver;
  seq: number;
  pendingFrames: Frame[];
  windowStart: number;
  log: LogApi;
  constructor(settings: CoreSettings);
  counter(name: string, dims?: Dimensions | null): CounterHandle;
  gauge(name: string, dims?: Dimensions | null): GaugeHandle;
  histogram(name: string, a?: HistogramOptions | null, b?: HistogramOptions | null): HistogramHandle;
  distinct(name: string, dims?: Dimensions | null): DistinctHandle;
  timer(name: string, dims?: Dimensions | null): StopTimer;
  event(name: string, attrs?: Attrs | null): void;
  retentionActivity(userId: string): void;
  identify(subjectId: string | null | undefined): void;
  configGet<T>(key: string, fallback: T, context?: SubjectContext): T;
  experimentGoal(name: string, context?: ExperimentGoalContext): void;
  applyConfig(version: number, config: ConfigSnapshot): void;
  snapshotIfDirty(): FrameBatch | null;
  snapshotFrame(): FrameBatch;
  takePendingFrames(): Frame[];
}

export function fnv1a32(input: string | Uint8Array): number;
export function assignmentHash(experimentId: string, subjectId: string, salt: string): number;
export function hashToUnitInterval(hash: number): number;
export function subjectHash(projectSalt: string, subjectId: string): string;
export function assignVariant(experiment: Experiment, subjectId: string): ExperimentVariant | null;
export function resolveSettings(options: CreateWardxOptions): ResolvedSettings;
export function loadSdkDefaults(): SdkDefaults;
export function nextSyncDelayMs(settings: Pick<ResolvedSettings, 'syncIntervalMs' | 'syncJitterMin' | 'syncJitterMax'>): number;
export function ulid(now?: number): string;
