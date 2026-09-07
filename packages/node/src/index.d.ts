import type {
  Attrs,
  ConfigSnapshot,
  ConfigValue,
  CoreSettings,
  CounterHandle,
  CreateWardxOptions,
  DimensionValue,
  Dimensions,
  DistinctHandle,
  EventTraceRecord,
  Experiment,
  ExperimentGoalContext,
  ExperimentVariant,
  FrameTraceRecord,
  GaugeHandle,
  HistogramHandle,
  HistogramOptions,
  LogApi,
  LogLevel,
  LogTraceRecord,
  MeasureTraceRecord,
  ResolvedSettings,
  SdkDefaults,
  StopTimer,
  SubjectContext,
  SyncTraceRecord,
  Tracer
} from '@wardx/core';

export type {
  Attrs,
  ConfigSnapshot,
  ConfigValue,
  CoreSettings,
  CounterHandle,
  CreateWardxOptions,
  DimensionValue,
  Dimensions,
  DistinctHandle,
  EventTraceRecord,
  Experiment,
  ExperimentGoalContext,
  ExperimentVariant,
  FrameTraceRecord,
  GaugeHandle,
  HistogramHandle,
  HistogramOptions,
  LogApi,
  LogLevel,
  LogTraceRecord,
  MeasureTraceRecord,
  ResolvedSettings,
  SdkDefaults,
  StopTimer,
  SubjectContext,
  SyncTraceRecord,
  Tracer
};

export interface ConsoleTracerOptions {
  stream?: { write(chunk: string): unknown };
}

export interface ConfigApi {
  get<T>(key: string, fallback: T, context?: SubjectContext): T;
}

export interface ExperimentApi {
  goal(name: string, context?: ExperimentGoalContext): void;
}

export class WardxNode {
  settings: ResolvedSettings;
  log: LogApi;
  config: ConfigApi;
  experiment: ExperimentApi;
  constructor(settings: ResolvedSettings);
  retentionActivity(userId: string): void;
  identify(subjectId: string | null | undefined): void;
  counter(name: string, dims?: Dimensions | null): CounterHandle;
  gauge(name: string, dims?: Dimensions | null): GaugeHandle;
  histogram(name: string, a?: HistogramOptions | null, b?: HistogramOptions | null): HistogramHandle;
  distinct(name: string, dims?: Dimensions | null): DistinctHandle;
  timer(name: string, dims?: Dimensions | null): StopTimer;
  event(name: string, attrs?: Attrs | null): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createWardx(options: CreateWardxOptions): WardxNode;
export function createConsoleTracer(options?: ConsoleTracerOptions): Tracer;
