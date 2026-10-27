import Foundation

/// Counters and distincts persisted to disk until the server acknowledges them. They survive
/// failed syncs and process restarts, and are reported in the window of the sync that delivers
/// them. Delivery is at-least-once: a lost acknowledgement re-sends the flight.
/// Mutations only mark the state dirty; `saveIfDirty` writes it, so disk writes stay bounded by
/// the aggregate interval. `maxRetainedSeries` bounds memory and file size.
final class RetainedMetrics {
    private static let formatVersion = 1

    private let url: URL
    private let pending: MetricsRegistry
    private let maxSeries: Int
    private let onCardinalityDropped: () -> Void
    private var series = Set<ObjectIdentifier>()
    private var flight: MetricSnapshot?
    private var dirty = false

    init(settings: Settings, path: String, onCardinalityDropped: @escaping () -> Void) {
        url = URL(fileURLWithPath: path)
        maxSeries = settings.maxRetainedSeries
        self.onCardinalityDropped = onCardinalityDropped
        pending = MetricsRegistry(
            maxSeriesPerMetric: settings.maxSeriesPerMetric,
            maxDimensionKeys: settings.maxDimensionKeys,
            maxDimensionValueLength: settings.maxDimensionValueLength,
            defaultHistogramBuckets: settings.histogramBuckets,
            privacySalt: settings.privacySalt,
            onCardinalityDropped: onCardinalityDropped
        )
        load()
    }

    func counter(_ name: String, _ dims: Dims?) throws -> (any Counter)? {
        guard let series = try pending.counter(name, dims), admit(series) else { return nil }
        return RetainedCounter(owner: self, series: series)
    }

    func distinct(_ name: String, _ dims: Dims?) throws -> (any Distinct)? {
        guard let series = try pending.distinct(name, dims), admit(series) else { return nil }
        return RetainedDistinct(owner: self, series: series)
    }

    private func admit(_ object: AnyObject) -> Bool {
        let id = ObjectIdentifier(object)
        if series.contains(id) { return true }
        if series.count >= maxSeries {
            onCardinalityDropped()
            return false
        }
        series.insert(id)
        return true
    }

    func markDirty() {
        dirty = true
    }

    func saveIfDirty() {
        if dirty { save() }
    }

    /// Moves pending values into the flight, or returns nil when nothing is pending or a flight is open.
    func beginFlight() -> MetricSnapshot? {
        guard flight == nil, pending.isDirty() else { return nil }
        flight = pending.snapshotAndReset()
        save()
        return flight
    }

    func commitFlight() {
        precondition(flight != nil, "no retained flight to commit")
        flight = nil
        save()
    }

    func abortFlight() {
        guard let open = flight else { preconditionFailure("no retained flight to abort") }
        try? restore(open)
        flight = nil
        save()
    }

    private func restore(_ snapshot: MetricSnapshot) throws {
        for row in snapshot.counters {
            if let series = try pending.counter(row.name, row.dims), admit(series) { series.add(row.value) }
        }
        for row in snapshot.distincts {
            if let series = try pending.distinct(row.name, row.dims), admit(series) { try series.merge(row.body) }
        }
    }

    private func save() {
        dirty = false
        let state: JSONValue = .object([
            "version": .number(Double(Self.formatVersion)),
            "pending": Self.wire(pending.snapshot()),
            "flight": flight.map(Self.wire) ?? .null
        ])
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(JSON.stringify(state).utf8).write(to: url, options: .atomic)
        } catch {
            // The values stay in memory; the next saveIfDirty retries the write.
            dirty = true
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: url) else { return }
        do {
            let state = try JSON.parse(data)
            guard state["version"]?.numberValue == Double(Self.formatVersion) else {
                throw WardxError("unsupported retained metrics version")
            }
            try restore(Self.parse(Self.field(state, "pending")))
            // An unacknowledged flight may or may not have reached the server; re-send it.
            let flight = try Self.field(state, "flight")
            if flight != .null { try restore(Self.parse(flight)) }
        } catch {
            // A corrupt file cannot be recovered; start empty instead of failing the host app.
            _ = pending.snapshotAndReset()
        }
        save()
    }

    private static func wire(_ snapshot: MetricSnapshot) -> JSONValue {
        .object([
            "counters": .array(snapshot.counters.map(Frame.wire)),
            "distincts": .array(snapshot.distincts.map(Frame.wire))
        ])
    }

    private static func parse(_ node: JSONValue) throws -> MetricSnapshot {
        var snapshot = MetricSnapshot()
        for row in try rows(node, "counters") {
            guard let value = row[2].numberValue else { throw WardxError("retained counter value must be a number") }
            snapshot.counters.append(CounterSample(name: try text(row[0]), dims: try dims(row[1]), value: value))
        }
        for row in try rows(node, "distincts") {
            guard let body = row[2].objectValue, let precision = body["precision"]?.numberValue else {
                throw WardxError("retained distinct body must be an object")
            }
            snapshot.distincts.append(DistinctSample(
                name: try text(row[0]),
                dims: try dims(row[1]),
                body: HllBody(precision: Int(precision), registers: try text(body["registers"] ?? .null))
            ))
        }
        return snapshot
    }

    private static func rows(_ node: JSONValue, _ key: String) throws -> [[JSONValue]] {
        guard let rows = try field(node, key).arrayValue else { throw WardxError("retained \(key) must be an array") }
        return try rows.map {
            guard let cells = $0.arrayValue, cells.count == 3 else { throw WardxError("retained metric rows must have 3 cells") }
            return cells
        }
    }

    private static func field(_ node: JSONValue, _ key: String) throws -> JSONValue {
        guard let value = node[key] else { throw WardxError("retained metrics are missing \(key)") }
        return value
    }

    private static func text(_ node: JSONValue) throws -> String {
        guard let value = node.stringValue else { throw WardxError("retained metrics expected a string") }
        return value
    }

    private static func dims(_ node: JSONValue) throws -> Dims? {
        if node == .null { return nil }
        guard let object = node.objectValue else { throw WardxError("retained dimensions must be an object") }
        return try object.mapValues {
            switch $0 {
            case .string(let value): return .string(value)
            case .number(let value): return .number(value)
            case .bool(let value): return .bool(value)
            default: throw WardxError("retained dimension values must be scalars")
            }
        }
    }
}

private final class RetainedCounter: Counter, @unchecked Sendable {
    private let owner: RetainedMetrics
    private let series: CounterSeries

    init(owner: RetainedMetrics, series: CounterSeries) {
        self.owner = owner
        self.series = series
    }

    func inc() {
        add(1)
    }

    func add(_ n: Double) {
        series.add(n)
        owner.markDirty()
    }
}

private final class RetainedDistinct: Distinct, @unchecked Sendable {
    private let owner: RetainedMetrics
    private let series: HyperLogLog

    init(owner: RetainedMetrics, series: HyperLogLog) {
        self.owner = owner
        self.series = series
    }

    func add(_ identifier: String) {
        series.add(identifier)
        owner.markDirty()
    }
}
