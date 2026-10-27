/// The in-process engine: series, buffers, Remote Config, experiments, and frame capture.
/// It is not synchronized; `WardxClient` guards every call with its lock.
final class WardxCore {
    // Retention channels and conversion goals are low-cardinality labels.
    static let retentionLabelPattern = "^[a-z0-9][a-z0-9._-]{0,63}$"

    private let settings: Settings
    private let tracer: (any WardxTracer)?
    private var wrappers: [ObjectIdentifier: Any] = [:]
    private var metrics: MetricsRegistry!
    private var events: EventBuffer
    private var logs: LogBuffer
    private(set) var experiments: ExperimentResolver!
    private var retained: RetainedMetrics?
    private var seq = 0
    private var snapshotOpen = false
    private var pendingFrames: [Frame] = []
    private var windowStart: Int64
    private var suspendedAt: Int64?
    private var resumedAt: Int64?
    private var suspended = false
    private var clockOffsetMs: Int64?
    private var subjectId: String?

    var internalMetrics = InternalMetrics()
    let configStore = ConfigStore()

    init(settings: Settings) {
        self.settings = settings
        tracer = settings.tracer
        events = EventBuffer(maxBufferedEvents: settings.maxBufferedEvents)
        logs = LogBuffer(maxBufferedLogs: settings.maxBufferedLogs)
        windowStart = Clock.unixMs()
        metrics = MetricsRegistry(
            maxSeriesPerMetric: settings.maxSeriesPerMetric,
            maxDimensionKeys: settings.maxDimensionKeys,
            maxDimensionValueLength: settings.maxDimensionValueLength,
            defaultHistogramBuckets: settings.histogramBuckets,
            privacySalt: settings.privacySalt
        ) { [unowned self] in internalMetrics.cardinalityDropped += 1 }
        experiments = ExperimentResolver(
            privacySalt: settings.privacySalt,
            stateMaxSubjects: settings.experimentStateMaxSubjects
        ) { [unowned self] payload in try? pushEvent("experiment.exposure", payload, traced: payload) }
        if let path = settings.retainedPath {
            retained = RetainedMetrics(settings: settings, path: path) { [unowned self] in
                internalMetrics.cardinalityDropped += 1
            }
        }
    }

    func counter(_ name: String, _ dims: Dims?) throws -> any Counter {
        let series = try metrics.counter(name, dims)
        return wrap(series, NoopCounter()) { TracedCounter($0, $1, name, dims, noop: $2) }
    }

    func gauge(_ name: String, _ dims: Dims?) throws -> any Gauge {
        let series = try metrics.gauge(name, dims)
        return wrap(series, NoopGauge()) { TracedGauge($0, $1, name, dims, noop: $2) }
    }

    func histogram(_ name: String, _ dims: Dims?, _ buckets: [Double]?) throws -> any Histogram {
        let series = try metrics.histogram(name, dims, buckets)
        return wrap(series, NoopHistogram()) { TracedHistogram($0, $1, name, dims, noop: $2) }
    }

    func distinct(_ name: String, _ dims: Dims?) throws -> any Distinct {
        let series = try metrics.distinct(name, dims)
        return wrap(series, NoopDistinct()) { TracedDistinct($0, $1, name, dims, noop: $2) }
    }

    func retainedCounter(_ name: String, _ dims: Dims?) throws -> any Counter {
        try retainedMetrics().counter(name, dims) ?? NoopCounter()
    }

    func retainedDistinct(_ name: String, _ dims: Dims?) throws -> any Distinct {
        try retainedMetrics().distinct(name, dims) ?? NoopDistinct()
    }

    private func retainedMetrics() throws -> RetainedMetrics {
        guard let retained else { throw WardxError("retained metrics require retainedPath") }
        return retained
    }

    func event(_ name: String, _ attrs: Dims?) throws {
        try pushEvent(name, jsonObject(attrs), traced: attrs)
    }

    private func pushEvent(_ name: String, _ attrs: [String: JSONValue]?, traced: Dims?) throws {
        let dropped = try !events.push(name, attrs)
        if dropped { internalMetrics.eventsDropped += 1 }
        tracer?.event(EventRecord(name: name, attrs: traced, dropped: dropped))
    }

    private func pushEvent(_ name: String, _ attrs: [String: JSONValue], traced: [String: JSONValue]) throws {
        let scalars = traced.compactMapValues { value -> WardxValue? in
            switch value {
            case .string(let text): return .string(text)
            case .number(let number): return .number(number)
            case .bool(let bool): return .bool(bool)
            default: return nil
            }
        }
        try pushEvent(name, attrs, traced: scalars)
    }

    func log(_ level: LogLevel, _ message: String, _ attrs: Dims?) throws {
        let dropped = try !logs.push(level, message, jsonObject(attrs))
        if dropped { internalMetrics.logsDropped += 1 }
        tracer?.log(LogRecord(level: level.wire, message: message, attrs: attrs, dropped: dropped))
    }

    func retentionActivity(userId: String, channel: String?) throws {
        var attrs = try retentionIdentity("retentionActivity", userId)
        if let channel {
            guard Self.isRetentionLabel(channel) else {
                throw WardxError("retentionActivity channel must match " + Self.retentionLabelPattern)
            }
            attrs["channel"] = .string(channel)
        }
        try pushEvent("retention.activity", attrs, traced: attrs)
    }

    func conversion(userId: String, goal: String) throws {
        var attrs = try retentionIdentity("conversion", userId)
        guard Self.isRetentionLabel(goal) else {
            throw WardxError("conversion goal must match " + Self.retentionLabelPattern)
        }
        attrs["goal"] = .string(goal)
        try pushEvent("retention.conversion", attrs, traced: attrs)
    }

    private func retentionIdentity(_ method: String, _ userId: String) throws -> [String: JSONValue] {
        if userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw WardxError(method + " requires a non-empty userId")
        }
        return [
            "subject": .string(Hash.subjectHash(salt: settings.privacySalt, subjectId: userId)),
            "salt": .string(Hash.subjectHash(salt: settings.privacySalt, subjectId: "wardx.retention.identity"))
        ]
    }

    static func isRetentionLabel(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard !scalars.isEmpty, scalars.count <= 64 else { return false }
        for (index, scalar) in scalars.enumerated() {
            let alphanumeric = ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
            if !alphanumeric && (index == 0 || (scalar != "." && scalar != "_" && scalar != "-")) { return false }
        }
        return true
    }

    func identify(_ subjectId: String?) throws {
        if subjectId?.isEmpty == true { throw WardxError("identify requires a non-empty subjectId") }
        self.subjectId = subjectId
    }

    func configGet(_ key: String, subjectId: String?) throws -> JSONValue? {
        guard let remote = configStore.values[key] else { return nil }
        guard let resolved = subjectId ?? self.subjectId else { return remote }
        return try experiments.resolve(key: key, remote: remote, subjectId: resolved, byKey: configStore.experimentsByKey)
    }

    func experimentGoal(_ name: String, subjectId: String?, value: Double?) throws {
        guard let subjectId = subjectId ?? self.subjectId else { throw WardxError("experiment.goal requires subjectId") }
        if name.isEmpty { throw WardxError("experiment.goal requires a metric name") }
        if let value, !value.isFinite { throw WardxError("experiment.goal value must be a finite number") }
        guard let assignment = try experiments.exposedAssignment(subjectId: subjectId, goalMetric: name) else { return }
        var payload: [String: JSONValue] = [
            "metric": .string(name),
            "subject": .string(experiments.hashSubject(subjectId)),
            "experiments": .array([
                .object(["experiment": .string(assignment.experiment), "variant": .string(assignment.variant)])
            ])
        ]
        if let value { payload["value"] = .number(value) }
        try pushEvent("experiment.goal", payload, traced: payload)
    }

    func applyConfig(version: Int, values: [String: JSONValue], experiments definitions: [ExperimentDefinition]) throws {
        try configStore.applySnapshot(version: version, values: values, experiments: definitions)
        experiments.applySnapshot(configStore.experiments)
        internalMetrics.configVersion = Double(version)
    }

    private var hasActivity: Bool {
        metrics.isDirty() || events.count > 0 || logs.count > 0 || internalMetrics.hasCounterActivity
    }

    /// Captures and commits a frame now, regardless of clock alignment.
    func snapshotFrame() throws -> FrameBatch {
        let batch = try FrameBuilder.split(captureFrame(), maxFrameBytes: settings.maxFrameBytes, maxFrameRows: settings.maxEnvelopeItems)
        try commitSnapshot(batch)
        traceSnapshot(batch)
        return batch
    }

    func captureFrameIfDirty() -> Frame? {
        clockAligned && hasActivity ? captureFrame() : nil
    }

    var clockAligned: Bool { clockOffsetMs != nil }

    func alignClock(serverTime: Int64, sentAt: Int64, receivedAt: Int64) {
        clockOffsetMs = serverTime - (sentAt + receivedAt) / 2
    }

    func suspend() {
        if suspended { return }
        suspended = true
        suspendedAt = Clock.unixMs()
    }

    func resume() {
        if !suspended { return }
        suspended = false
        let now = Clock.unixMs()
        if suspendedAt != nil && hasActivity {
            resumedAt = now
            return
        }
        suspendedAt = nil
        windowStart = now
    }

    private func captureFrame() -> Frame {
        let to = suspendedAt ?? Clock.unixMs()
        let from = windowStart
        windowStart = resumedAt ?? to
        suspendedAt = nil
        resumedAt = nil
        internalMetrics.eventsBuffered = Double(events.count)
        internalMetrics.logsBuffered = Double(logs.count)
        var frame = FrameBuilder.build(
            seq: seq + 1,
            from: from,
            to: to,
            metrics: metrics.snapshotAndReset(),
            events: events.swap(),
            logs: logs.swap(),
            internals: internalMetrics.snapshotAndReset()
        )
        FrameBuilder.shiftTime(&frame, by: clockOffsetMs ?? 0)
        snapshotOpen = true
        return frame
    }

    func abandonSnapshot() {
        snapshotOpen = false
    }

    func commitSnapshot(_ batch: FrameBatch) throws {
        guard batch.frames[0].seq == seq + 1 else { throw WardxError("snapshots must be completed in sequence") }
        snapshotOpen = false
        seq = batch.frames[batch.frames.count - 1].seq
        let capacity = settings.maxPendingFrames
        let overflow = max(0, pendingFrames.count + batch.frames.count - capacity)
        if overflow > 0 {
            pendingFrames.removeFirst(min(overflow, pendingFrames.count))
            internalMetrics.framesFailed += Double(overflow)
        }
        pendingFrames.append(contentsOf: batch.frames.suffix(capacity))
    }

    /// Opens a retained flight stamped at the current aligned time. The caller must end it with
    /// `commitRetained` or `abortRetained` once the frames are delivered or lost. A snapshot that is
    /// still being split owns the next seq, so the flight waits for a later sync.
    func captureRetainedFrames() throws -> FrameBatch? {
        guard let retained, let offset = clockOffsetMs, !snapshotOpen, let metrics = retained.beginFlight() else { return nil }
        let now = Clock.unixMs() + offset
        let frame = Frame(seq: seq + 1, from: now, to: now, counters: metrics.counters, distincts: metrics.distincts)
        let batch: FrameBatch
        do {
            batch = try FrameBuilder.split(frame, maxFrameBytes: settings.maxFrameBytes, maxFrameRows: settings.maxEnvelopeItems)
        } catch {
            retained.abortFlight()
            throw error
        }
        seq = batch.frames[batch.frames.count - 1].seq
        return batch
    }

    func saveRetained() {
        retained?.saveIfDirty()
    }

    func commitRetained() {
        retained!.commitFlight()
    }

    func abortRetained() {
        retained!.abortFlight()
    }

    func traceSnapshot(_ batch: FrameBatch) {
        guard let tracer else { return }
        for (index, frame) in batch.frames.enumerated() {
            tracer.frame(FrameRecord(
                seq: frame.seq,
                from: frame.from,
                to: frame.to,
                counters: frame.counters.count,
                gauges: frame.gauges.count,
                histograms: frame.histograms.count,
                distincts: frame.distincts.count,
                events: frame.events.count,
                logs: frame.logs.count,
                droppedLogs: index == 0 ? batch.droppedLogs : 0,
                droppedEvents: index == 0 ? batch.droppedEvents : 0,
                droppedRows: index == 0 ? batch.droppedRows : 0
            ))
        }
    }

    func takePendingFrames() -> [Frame] {
        defer { pendingFrames = [] }
        return pendingFrames
    }

    /// Returns the end index of the frames from `start` that fit one envelope; at least one frame
    /// always goes, since each was already split within `maxFrameBytes`.
    func envelopeEnd(_ frames: [Frame], start: Int, baseBytes: Int) -> Int {
        var end = start
        var items = 0
        var bytes = baseBytes
        while end < frames.count {
            let frame = frames[end]
            precondition(frame.wireBytes > 0, "pending frame has no measured size")
            let nextItems = items + frame.rowCount
            let nextBytes = bytes + frame.wireBytes + (end > start ? 1 : 0)
            if end > start && (nextItems > settings.maxEnvelopeItems || nextBytes > settings.maxEnvelopeBytes) { break }
            items = nextItems
            bytes = nextBytes
            end += 1
        }
        return end
    }

    func recordProcessRss(_ bytes: Double) {
        internalMetrics.processRssBytes = bytes
    }

    func recordSyncBytes(uncompressed: Int, compressed: Int) {
        internalMetrics.bytesUncompressed += Double(uncompressed)
        internalMetrics.bytesCompressed += Double(compressed)
    }

    func recordSyncResult(ok: Bool, frames: Int, ms: Double) {
        internalMetrics.lastSyncMs = ms
        if ok { internalMetrics.framesSent += Double(frames) } else { internalMetrics.framesFailed += Double(max(frames, 1)) }
    }

    func recordSyncError() {
        internalMetrics.framesFailed += 1
    }

    func recordConfigVersion(_ version: Double) {
        internalMetrics.configVersion = version
    }

    private func wrap<T>(_ series: AnyObject?, _ noop: T, _ traced: (T, any WardxTracer, Bool) -> T) -> T {
        guard let series else { return tracer.map { traced(noop, $0, true) } ?? noop }
        guard let tracer else { return series as! T }
        let id = ObjectIdentifier(series)
        if let cached = wrappers[id] as? T { return cached }
        let wrapped = traced(series as! T, tracer, false)
        wrappers[id] = wrapped
        return wrapped
    }
}
