import Foundation

struct SyncFlags: Sendable {
    var bootstrap = false
    var flush = false
}

/// The Wardx SDK instance. Measure calls only change local memory; syncs run in the background.
/// All methods are safe to call from any thread.
public final class WardxClient: @unchecked Sendable {
    private let settings: Settings
    let core: WardxCore?
    private let transport: (any SyncTransport)?
    private let readRssBytes: @Sendable () -> Double
    private let sdk: SdkIdentity
    private let instanceId = Ids.ulid()
    private let sessionId = Ids.ulid()

    /// Guards the core, attributes, and config context.
    private let gate = NSLock()
    /// Guards stop state, the shutdown task, and the scheduler. Taken before `queueGate`.
    private let lifecycleGate = NSLock()
    /// Guards the coalescing sync and snapshot queues.
    private let queueGate = NSLock()

    private var attributes: [String: JSONValue] = [:]
    private var configContext: String?
    private var stopped = false
    private var shutdownTask: Task<Void, Never>?
    private var stopScheduler: (() -> Void)?
    private var lifecycle: LifecycleObserver?
    private var syncTail: Task<Void, Never>?
    private var queuedSync: PendingSync?
    private var snapshotTail: Task<Void, Never>?
    private var queuedSnapshot: PendingSnapshot?

    private init(settings: Settings, transport: (any SyncTransport)?, readRssBytes: @escaping @Sendable () -> Double, sdk: SdkIdentity) throws {
        self.settings = settings
        self.transport = transport
        self.readRssBytes = readRssBytes
        self.sdk = sdk
        guard settings.enabled else {
            core = nil
            return
        }
        attributes = try Self.validateAttributes(settings.attributes ?? [:])
        core = WardxCore(settings: settings)
    }

    deinit {
        stopScheduler?()
        lifecycle?.remove()
    }

    /// Creates a client that bootstraps immediately, then syncs every `syncIntervalMs` with jitter.
    /// On macOS, sleep cuts the frame window and flushes, and wake resumes it; on iOS, entering
    /// the background does the same. Termination stops without a final flush.
    public static func create(_ options: WardxOptions) throws -> WardxClient {
        var settings = try Settings.resolve(options)
        guard settings.enabled else { return try WardxClient(settings: settings, transport: nil, readRssBytes: { 0 }, sdk: .current) }
        if settings.retainedPath == nil {
            settings.retainedPath = Platform.defaultRetainedPath(project: settings.project, role: settings.role)
        }
        let transport = try URLSessionTransport(
            endpoint: settings.endpoint,
            projectKey: settings.projectKey,
            httpTimeoutMs: settings.httpTimeoutMs
        )
        let client = try WardxClient(settings: settings, transport: transport, readRssBytes: Platform.residentBytes, sdk: .current)
        client.stopScheduler = Scheduler.start(client, settings: settings)
        client.lifecycle = LifecycleObserver(client: client)
        client.enqueueSync(SyncFlags(bootstrap: true))
        return client
    }

    /// Creates a client over a custom transport, without a scheduler: the caller drives
    /// `flush()` and `shutdown()`.
    public static func create(_ options: WardxOptions, transport: any SyncTransport) throws -> WardxClient {
        try WardxClient(settings: Settings.resolve(options), transport: transport, readRssBytes: { 0 }, sdk: .current)
    }

    static func create(_ options: WardxOptions, transport: any SyncTransport, sdk: SdkIdentity) throws -> WardxClient {
        try WardxClient(settings: Settings.resolve(options), transport: transport, readRssBytes: { 0 }, sdk: sdk)
    }

    public var log: WardxLog { WardxLog(client: self) }
    public var config: WardxConfig { WardxConfig(client: self) }
    public var experiment: WardxExperiment { WardxExperiment(client: self) }

    public func counter(_ name: String, _ dims: Dims? = nil) -> any Counter {
        withCore(NoopCounter() as any Counter) { LockedCounter(gate, try $0.counter(name, dims)) }
    }

    public func gauge(_ name: String, _ dims: Dims? = nil) -> any Gauge {
        withCore(NoopGauge() as any Gauge) { LockedGauge(gate, try $0.gauge(name, dims)) }
    }

    public func histogram(_ name: String, _ dims: Dims? = nil, buckets: [Double]? = nil) -> any Histogram {
        withCore(NoopHistogram() as any Histogram) { LockedHistogram(gate, try $0.histogram(name, dims, buckets)) }
    }

    public func distinct(_ name: String, _ dims: Dims? = nil) -> any Distinct {
        withCore(NoopDistinct() as any Distinct) { LockedDistinct(gate, try $0.distinct(name, dims)) }
    }

    /// A counter persisted to `retainedPath` until a sync delivers it, reported in that sync's window.
    public func retainedCounter(_ name: String, _ dims: Dims? = nil) -> any Counter {
        withCore(NoopCounter() as any Counter) { LockedCounter(gate, try $0.retainedCounter(name, dims)) }
    }

    /// A distinct persisted to `retainedPath` until a sync delivers it, reported in that sync's window.
    public func retainedDistinct(_ name: String, _ dims: Dims? = nil) -> any Distinct {
        withCore(NoopDistinct() as any Distinct) { LockedDistinct(gate, try $0.retainedDistinct(name, dims)) }
    }

    public func timer(_ name: String, _ dims: Dims? = nil) -> TimerToken {
        guard core != nil else { return TimerToken { _ in } }
        let start = Clock.monotonicMs()
        return TimerToken { [self] endDims in
            let duration = Clock.monotonicMs() - start
            withCore(()) { try $0.histogram(name, Dimensions.merge(dims, endDims), nil).observe(duration) }
        }
    }

    public func event(_ name: String, _ attrs: Dims? = nil) {
        withCore(()) { try $0.event(name, attrs) }
    }

    /// Records activity for an explicit, stable user identity with an optional first-touch channel.
    public func retentionActivity(_ userId: String, channel: String? = nil) {
        withCore(()) { try $0.retentionActivity(userId: userId, channel: channel) }
    }

    /// Records that the user reached a goal such as `purchase`, for cohort conversion.
    public func conversion(_ userId: String, goal: String) {
        withCore(()) { try $0.conversion(userId: userId, goal: goal) }
    }

    /// Sets the default experiment subject; `nil` clears it.
    public func identify(_ subjectId: String?) {
        withCore(()) { try $0.identify(subjectId) }
    }

    /// Replaces the instance attributes sent with every sync for conditional Remote Config.
    public func setAttributes(_ attributes: Dims) {
        guard core != nil else { return }
        do {
            let copy = try Self.validateAttributes(attributes)
            gate.withLock { self.attributes = copy }
        } catch {
            reportMisuse("\(error)")
        }
    }

    /// Sends pending frames and keeps scheduling.
    public func flush() async {
        await enqueueSync(SyncFlags(flush: true)).value
    }

    /// Stops scheduling, sends pending frames, and closes the transport.
    public func shutdown() async {
        guard core != nil else { return }
        let task: Task<Void, Never> = lifecycleGate.withLock {
            if let shutdownTask { return shutdownTask }
            stopped = true
            stopScheduler?()
            let task = Task.detached { [self] in await shutdownCore() }
            shutdownTask = task
            return task
        }
        await task.value
    }

    /// Stops without a final flush; retained values are saved.
    public func stop() {
        guard let core else { return }
        gate.withLock { core.saveRetained() }
        let first: Bool = lifecycleGate.withLock {
            if stopped { return false }
            stopped = true
            stopScheduler?()
            return true
        }
        if first { transport!.close() }
        lifecycle?.remove()
    }

    private func shutdownCore() async {
        let current = queueGate.withLock { syncTail }
        await current?.value
        await runBoundedSync(SyncFlags(flush: true))
        gate.withLock { core!.saveRetained() }
        transport!.close()
        lifecycle?.remove()
    }

    func aggregateTick() {
        guard core != nil else { return }
        lifecycleGate.withLock {
            if stopped { return }
            enqueueSnapshot()
        }
    }

    /// Cuts the frame window, saves retained values, and flushes; returns the flush.
    @discardableResult
    func suspend() -> Task<Void, Never> {
        guard let core else { return Task {} }
        gate.withLock {
            core.suspend()
            core.saveRetained()
        }
        return enqueueSync(SyncFlags(flush: true))
    }

    func resume() {
        guard let core else { return }
        gate.withLock { core.resume() }
    }

    func configGet<T: ConfigValue>(_ key: String, _ fallback: T, subjectId: String?) -> T {
        withCore(fallback) { core in
            guard let value = try core.configGet(key, subjectId: subjectId) else { return fallback }
            return T(configValue: value) ?? fallback
        }
    }

    func goal(_ name: String, subjectId: String?, value: Double?) {
        withCore(()) { try $0.experimentGoal(name, subjectId: subjectId, value: value) }
    }

    func writeLog(_ level: LogLevel, _ message: String, _ attrs: Dims?) {
        withCore(()) { try $0.log(level, message, attrs) }
    }

    /// Runs `body` under the lock; a misuse error is reported and yields `fallback`.
    private func withCore<T>(_ fallback: T, _ body: (WardxCore) throws -> T) -> T {
        guard let core else { return fallback }
        return gate.withLock {
            do {
                return try body(core)
            } catch {
                reportMisuse("\(error)")
                return fallback
            }
        }
    }

    // MARK: - Queues

    @discardableResult
    func enqueueSnapshot() -> Task<Void, Never> {
        guard core != nil else { return Task {} }
        return queueGate.withLock {
            if let queued = queuedSnapshot { return queued.task! }
            let pending = PendingSnapshot()
            let previous = snapshotTail
            let task = Task.detached { [self] in
                await previous?.value
                queueGate.withLock { if queuedSnapshot === pending { queuedSnapshot = nil } }
                buildSnapshot()
            }
            pending.task = task
            queuedSnapshot = pending
            snapshotTail = task
            return task
        }
    }

    private func buildSnapshot() {
        let core = core!
        let rss = readRssBytes()
        let frame: Frame? = gate.withLock {
            core.saveRetained()
            core.recordProcessRss(rss)
            return core.captureFrameIfDirty()
        }
        guard let frame else { return }
        do {
            let batch = try FrameBuilder.split(frame, maxFrameBytes: settings.maxFrameBytes, maxFrameRows: settings.maxEnvelopeItems)
            try gate.withLock { try core.commitSnapshot(batch) }
            core.traceSnapshot(batch)
        } catch {
            gate.withLock {
                core.abandonSnapshot()
                core.recordSyncError()
            }
        }
    }

    @discardableResult
    func enqueueSync(_ flags: SyncFlags) -> Task<Void, Never> {
        guard core != nil else { return Task {} }
        return lifecycleGate.withLock {
            if stopped { return shutdownTask ?? Task {} }
            return queueGate.withLock {
                if let queued = queuedSync {
                    queued.flags.flush = queued.flags.flush || flags.flush
                    queued.flags.bootstrap = queued.flags.bootstrap || flags.bootstrap
                    return queued.task!
                }
                let pending = PendingSync(flags: flags)
                let previous = syncTail
                let task = Task.detached { [self] in
                    await previous?.value
                    let flags = queueGate.withLock {
                        if queuedSync === pending { queuedSync = nil }
                        return pending.flags
                    }
                    await runBoundedSync(flags)
                }
                pending.task = task
                queuedSync = pending
                syncTail = task
                return task
            }
        }
    }

    // MARK: - Sync

    private func runBoundedSync(_ flags: SyncFlags) async {
        let deadline = Clock.monotonicMs() + Double(settings.httpTimeoutMs)
        if lifecycleGate.withLock({ stopped }) && !flags.flush { return }
        do {
            try await syncOnce(flags, deadline: deadline)
        } catch {
            gate.withLock { core!.recordSyncError() }
        }
    }

    private func syncOnce(_ flags: SyncFlags, deadline: Double) async throws {
        let core = core!
        let aligned = gate.withLock { core.clockAligned }
        let forced = flags.flush || flags.bootstrap
        if try await !sendPending(flags, sendEmpty: !aligned || forced, deadline: deadline) { return }
        if aligned || !forced { return }
        if gate.withLock({ core.clockAligned }) {
            _ = try await sendPending(flags, sendEmpty: false, deadline: deadline)
        }
    }

    private func sendPending(_ flags: SyncFlags, sendEmpty: Bool, deadline: Double) async throws -> Bool {
        if flags.flush || flags.bootstrap {
            await enqueueSnapshot().value
        } else {
            await queueGate.withLock { snapshotTail }?.value
        }
        let frames = gate.withLock { core!.takePendingFrames() }
        let phase = flags.bootstrap ? "bootstrap" : flags.flush ? "flush" : "tick"
        if sendEmpty || !frames.isEmpty {
            let sent = await postFrames(phase, frames, deadline: deadline)
            if !sent.ok { return false }
        }
        return try await sendRetained(phase, deadline: deadline)
    }

    /// Retained frames travel in their own envelopes after the regular ones, so they can never
    /// take regular frames down with them. A permanent rejection drops the flight instead of
    /// retrying it on every sync.
    private func sendRetained(_ phase: String, deadline: Double) async throws -> Bool {
        let core = core!
        guard let retained = try gate.withLock({ try core.captureRetainedFrames() }) else { return true }
        core.traceSnapshot(retained)
        let sent = await postFrames(phase, retained.frames, deadline: deadline)
        let settled = sent.ok || [400, 413, 415].contains(sent.status)
        gate.withLock {
            if settled { core.commitRetained() } else { core.abortRetained() }
        }
        return sent.ok
    }

    private func postFrames(_ phase: String, _ frames: [Frame], deadline: Double) async -> (ok: Bool, status: Int?) {
        var start = 0
        repeat {
            let sent = await postEnvelope(phase, frames, start: start, deadline: deadline)
            if !sent.ok { return (false, sent.status) }
            start = sent.end
        } while start < frames.count
        return (true, nil)
    }

    private func postEnvelope(_ phase: String, _ frames: [Frame], start: Int, deadline: Double) async -> (ok: Bool, end: Int, status: Int?) {
        let core = core!
        let transport = transport!
        let unsent = frames.count - start
        var count = unsent
        var bytesUncompressed = 0
        var bytesCompressed = 0
        var started = Clock.monotonicMs()
        do {
            try Self.checkDeadline(deadline)
            var envelope = buildEnvelope()
            let end = core.envelopeEnd(frames, start: start, baseBytes: JSON.byteCount(.object(envelope)))
            envelope["frames"] = .array(frames[start..<end].map { $0.wire() })
            let json = Data(JSON.stringify(.object(envelope)).utf8)
            let body = try Gzip.compress(json)
            count = end - start
            bytesUncompressed = json.count
            bytesCompressed = body.count
            gate.withLock { core.recordSyncBytes(uncompressed: bytesUncompressed, compressed: bytesCompressed) }
            try Self.checkDeadline(deadline)
            started = Clock.monotonicMs()
            let sentAt = Clock.unixMs()
            let result = try await Self.withDeadline(deadline) { try await transport.post(body) }
            let receivedAt = Clock.unixMs()
            let ms = Clock.monotonicMs() - started
            guard result.ok else {
                gate.withLock { core.recordSyncResult(ok: false, frames: unsent, ms: ms) }
                traceSync(phase, count, bytesUncompressed, bytesCompressed, ms, ok: false, status: result.status, applied: false)
                return (false, start, result.status)
            }
            let (applied, version) = try gate.withLock {
                let applied = try applyResponse(result.text, sentAt: sentAt, receivedAt: receivedAt)
                core.recordSyncResult(ok: true, frames: count, ms: ms)
                return (applied, core.configStore.version)
            }
            traceSync(phase, count, bytesUncompressed, bytesCompressed, ms, ok: true, status: result.status, applied: applied, version: version)
            return (true, end, result.status)
        } catch {
            let ms = Clock.monotonicMs() - started
            gate.withLock { core.recordSyncResult(ok: false, frames: unsent, ms: ms) }
            traceSync(phase, count, bytesUncompressed, bytesCompressed, ms, ok: false, status: nil, applied: false)
            return (false, start, nil)
        }
    }

    private func buildEnvelope() -> [String: JSONValue] {
        let (configVersion, configContext, attributes) = gate.withLock {
            (core!.configStore.version, self.configContext, self.attributes)
        }
        var envelope: [String: JSONValue] = [
            "protocol": .number(Double(WireProtocol.version)),
            "project": .string(settings.project),
            "sdk": .object(["name": .string(sdk.name), "version": .string(sdk.version)]),
            "client": .object([
                "instanceId": .string(instanceId),
                "sessionId": .string(sessionId),
                "role": .string(settings.role),
                "appVersion": .string(settings.appVersion),
                "environment": .string(settings.environment),
                "platform": .string(sdk.platform),
                "os": .string(sdk.os),
                "attributes": .object(attributes)
            ]),
            "configVersion": .number(Double(configVersion)),
            "frames": .array([])
        ]
        if let configContext { envelope["configContext"] = .string(configContext) }
        return envelope
    }

    /// Applies a successful response under the lock; returns whether it carried a config snapshot.
    private func applyResponse(_ text: String?, sentAt: Int64, receivedAt: Int64) throws -> Bool {
        let core = core!
        guard let text, !text.isEmpty, let json = try? JSON.parse(text), json["ok"] == .bool(true) else { return false }
        guard let serverTime = json["serverTime"]?.numberValue else { throw WardxError("sync response is missing serverTime") }
        core.alignClock(serverTime: Int64(serverTime), sentAt: sentAt, receivedAt: receivedAt)
        let version = json["configVersion"]?.numberValue
        if let version { core.recordConfigVersion(version) }
        guard let config = json["config"]?.objectValue, let version else { return false }
        let experiments = (config["experiments"]?.arrayValue ?? []).compactMap(\.objectValue).map(ExperimentDefinition.init(wire:))
        try core.applyConfig(version: Int(version), values: config["values"]?.objectValue ?? [:], experiments: experiments)
        configContext = json["configContext"]?.stringValue
        return true
    }

    private func traceSync(
        _ phase: String,
        _ frames: Int,
        _ bytesUncompressed: Int,
        _ bytesCompressed: Int,
        _ ms: Double,
        ok: Bool,
        status: Int?,
        applied: Bool,
        version: Int? = nil
    ) {
        settings.tracer?.sync(SyncRecord(
            phase: phase,
            frames: frames,
            bytesUncompressed: bytesUncompressed,
            bytesCompressed: bytesCompressed,
            ms: ms,
            ok: ok,
            status: status,
            configVersion: version,
            appliedConfig: applied
        ))
    }

    private static func checkDeadline(_ deadline: Double) throws {
        if Clock.monotonicMs() >= deadline { throw WardxError("sync timed out") }
    }

    /// Races `operation` against the deadline. On timeout the operation is cancelled and abandoned,
    /// so a transport that ignores cancellation cannot hold the sync queue.
    private static func withDeadline<T: Sendable>(_ deadline: Double, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let race = Race<T>()
        return try await withCheckedThrowingContinuation { continuation in
            race.start(continuation)
            let timeout = Task {
                let remaining = max(0, deadline - Clock.monotonicMs())
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000))
                race.finish(.failure(WardxError("sync timed out")))
            }
            let work = Task {
                do { race.finish(.success(try await operation())) } catch { race.finish(.failure(error)) }
            }
            race.attach(work: work, timeout: timeout)
        }
    }

    private static func validateAttributes(_ attributes: Dims) throws -> [String: JSONValue] {
        for (key, value) in attributes {
            if key.isEmpty { throw WardxError("attributes keys must be non-empty strings") }
            if !value.isFinite { throw WardxError("attributes values must be finite numbers") }
        }
        return attributes.mapValues(\.json)
    }
}

private final class PendingSync: @unchecked Sendable {
    var flags: SyncFlags
    var task: Task<Void, Never>?

    init(flags: SyncFlags) {
        self.flags = flags
    }
}

private final class PendingSnapshot: @unchecked Sendable {
    var task: Task<Void, Never>?
}

/// Resumes a continuation once with whichever of the work or the timeout finishes first,
/// then cancels the other.
private final class Race<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var work: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var finished = false

    func start(_ continuation: CheckedContinuation<T, Error>) {
        lock.withLock { self.continuation = continuation }
    }

    func attach(work: Task<Void, Never>, timeout: Task<Void, Never>) {
        let done = lock.withLock {
            self.work = work
            self.timeout = timeout
            return finished
        }
        if done {
            work.cancel()
            timeout.cancel()
        }
    }

    func finish(_ result: Result<T, Error>) {
        let (continuation, work, timeout) = lock.withLock { () -> (CheckedContinuation<T, Error>?, Task<Void, Never>?, Task<Void, Never>?) in
            if finished { return (nil, nil, nil) }
            finished = true
            defer { self.continuation = nil }
            return (self.continuation, self.work, self.timeout)
        }
        guard let continuation else { return }
        work?.cancel()
        timeout?.cancel()
        continuation.resume(with: result)
    }
}

private enum Scheduler {
    private final class WeakClient: @unchecked Sendable {
        weak var client: WardxClient?

        init(_ client: WardxClient) {
            self.client = client
        }
    }

    static func start(_ client: WardxClient, settings: Settings) -> () -> Void {
        let reference = WeakClient(client)
        let aggregate = Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(settings.aggregateIntervalMs) * 1_000_000)
                guard !Task.isCancelled, let client = reference.client else { return }
                client.aggregateTick()
            }
        }
        let sync = Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(max(1, settings.nextSyncDelayMs())) * 1_000_000)
                guard !Task.isCancelled, let client = reference.client else { return }
                await client.enqueueSync(SyncFlags()).value
            }
        }
        return {
            aggregate.cancel()
            sync.cancel()
        }
    }
}

final class LockedCounter: Counter, @unchecked Sendable {
    private let gate: NSLock
    private let inner: any Counter

    init(_ gate: NSLock, _ inner: any Counter) {
        self.gate = gate
        self.inner = inner
    }

    func inc() {
        gate.withLock { inner.inc() }
    }

    func add(_ n: Double) {
        gate.withLock { inner.add(n) }
    }
}

final class LockedGauge: Gauge, @unchecked Sendable {
    private let gate: NSLock
    private let inner: any Gauge

    init(_ gate: NSLock, _ inner: any Gauge) {
        self.gate = gate
        self.inner = inner
    }

    func set(_ value: Double) {
        gate.withLock { inner.set(value) }
    }
}

final class LockedHistogram: Histogram, @unchecked Sendable {
    private let gate: NSLock
    private let inner: any Histogram

    init(_ gate: NSLock, _ inner: any Histogram) {
        self.gate = gate
        self.inner = inner
    }

    func observe(_ value: Double, attrs: Dims?) {
        gate.withLock { inner.observe(value, attrs: attrs) }
    }
}

final class LockedDistinct: Distinct, @unchecked Sendable {
    private let gate: NSLock
    private let inner: any Distinct

    init(_ gate: NSLock, _ inner: any Distinct) {
        self.gate = gate
        self.inner = inner
    }

    func add(_ identifier: String) {
        gate.withLock { inner.add(identifier) }
    }
}

public struct WardxLog: Sendable {
    let client: WardxClient

    public func debug(_ message: String, _ attrs: Dims? = nil) { client.writeLog(.debug, message, attrs) }
    public func info(_ message: String, _ attrs: Dims? = nil) { client.writeLog(.info, message, attrs) }
    public func warn(_ message: String, _ attrs: Dims? = nil) { client.writeLog(.warn, message, attrs) }
    public func error(_ message: String, _ attrs: Dims? = nil) { client.writeLog(.error, message, attrs) }
}

public struct WardxConfig: Sendable {
    let client: WardxClient

    /// Reads the local Remote Config snapshot, resolving an experiment variant for the subject
    /// (or the `identify` default). Returns `fallback` when the key is missing or has another type.
    public func get<T: ConfigValue>(_ key: String, _ fallback: T, subjectId: String? = nil) -> T {
        client.configGet(key, fallback, subjectId: subjectId)
    }
}

public struct WardxExperiment: Sendable {
    let client: WardxClient

    /// Records a conversion or quantitative outcome for a subject exposed to an experiment.
    public func goal(_ name: String, subjectId: String? = nil, value: Double? = nil) {
        client.goal(name, subjectId: subjectId, value: value)
    }
}
