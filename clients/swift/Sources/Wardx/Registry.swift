enum DimensionCheck {
    case ok(Dims?)
    case fail(String)
}

enum Dimensions {
    static func dimKey(_ dims: Dims?) -> String {
        guard let dims, !dims.isEmpty else { return "" }
        return dims.keys.sorted().map { $0 + "=" + dims[$0]!.text }.joined(separator: "\n")
    }

    static func validate(_ dims: Dims?, maxKeys: Int, maxValueLength: Int) throws -> DimensionCheck {
        guard let dims, !dims.isEmpty else { return .ok(nil) }
        if dims.count > maxKeys { return .fail("maxDimensionKeys") }
        for (key, value) in dims {
            guard value.isFinite else { throw WardxError("dimension \(key) must be string, number, or boolean") }
            if value.text.utf16.count > maxValueLength { return .fail("maxDimensionValueLength") }
        }
        return .ok(dims)
    }

    static func merge(_ start: Dims?, _ end: Dims?) -> Dims? {
        guard let end, !end.isEmpty else { return start }
        guard let start, !start.isEmpty else { return end }
        return start.merging(end) { _, last in last }
    }
}

struct CounterSample {
    let name: String
    let dims: Dims?
    let value: Double
}

struct GaugeSample {
    let name: String
    let dims: Dims?
    let value: Double
    let timestamp: Int64
}

struct HistogramSample {
    let name: String
    let dims: Dims?
    let body: HistogramBody
}

struct DistinctSample {
    let name: String
    let dims: Dims?
    let body: HllBody
}

struct MetricSnapshot {
    var counters: [CounterSample] = []
    var gauges: [GaugeSample] = []
    var histograms: [HistogramSample] = []
    var distincts: [DistinctSample] = []
}

/// Series keyed by metric name and dimension set, bounded per name by `maxSeriesPerMetric`.
/// Each kind keeps insertion order so frames list series deterministically.
final class MetricsRegistry {
    private let maxSeriesPerMetric: Int
    private let maxDimensionKeys: Int
    private let maxDimensionValueLength: Int
    private let defaultHistogramBuckets: [Double]
    private let onCardinalityDropped: () -> Void
    private let privacySalt: String
    private var counters = SeriesMap<CounterSeries>()
    private var gauges = SeriesMap<GaugeSeries>()
    private var histograms = SeriesMap<HistogramSeries>()
    private var distincts = SeriesMap<HyperLogLog>()
    private var rejected = Set<String>()

    init(
        maxSeriesPerMetric: Int,
        maxDimensionKeys: Int,
        maxDimensionValueLength: Int,
        defaultHistogramBuckets: [Double],
        privacySalt: String,
        onCardinalityDropped: @escaping () -> Void
    ) {
        self.maxSeriesPerMetric = maxSeriesPerMetric
        self.maxDimensionKeys = maxDimensionKeys
        self.maxDimensionValueLength = maxDimensionValueLength
        self.defaultHistogramBuckets = defaultHistogramBuckets
        self.privacySalt = privacySalt
        self.onCardinalityDropped = onCardinalityDropped
    }

    func counter(_ name: String, _ dims: Dims?) throws -> CounterSeries? {
        try series(&counters, "c", name, dims) { CounterSeries(name: name, dims: $0) }
    }

    func gauge(_ name: String, _ dims: Dims?) throws -> GaugeSeries? {
        try series(&gauges, "g", name, dims) { GaugeSeries(name: name, dims: $0) }
    }

    func histogram(_ name: String, _ dims: Dims?, _ buckets: [Double]?) throws -> HistogramSeries? {
        let bounds = buckets ?? defaultHistogramBuckets
        try assertBuckets(bounds, "histogram buckets")
        let histogram = try series(&histograms, "h", name, dims) {
            HistogramSeries(
                name: name,
                dims: $0,
                bounds: bounds,
                maxDimensionKeys: maxDimensionKeys,
                maxDimensionValueLength: maxDimensionValueLength
            )
        }
        if let histogram, histogram.bounds != bounds {
            throw WardxError("histogram \(name) buckets cannot change for an existing series")
        }
        return histogram
    }

    func distinct(_ name: String, _ dims: Dims?) throws -> HyperLogLog? {
        try series(&distincts, "d", name, dims) { HyperLogLog(name: name, dims: $0, privacySalt: privacySalt) }
    }

    func snapshotAndReset() -> MetricSnapshot {
        snapshot(reset: true)
    }

    func snapshot() -> MetricSnapshot {
        snapshot(reset: false)
    }

    private func snapshot(reset: Bool) -> MetricSnapshot {
        var snapshot = MetricSnapshot()
        for series in counters.all where series.value != 0 {
            snapshot.counters.append(CounterSample(name: series.name, dims: series.dims, value: series.value))
            if reset { series.value = 0 }
        }
        for series in gauges.all where series.dirty {
            snapshot.gauges.append(GaugeSample(name: series.name, dims: series.dims, value: series.value, timestamp: series.timestamp))
            if reset { series.dirty = false }
        }
        for series in histograms.all where series.count > 0 {
            snapshot.histograms.append(HistogramSample(name: series.name, dims: series.dims, body: series.snapshot()))
            if reset { series.reset() }
        }
        for series in distincts.all where series.dirty {
            snapshot.distincts.append(DistinctSample(name: series.name, dims: series.dims, body: series.snapshot()))
            if reset { series.reset() }
        }
        return snapshot
    }

    func isDirty() -> Bool {
        counters.all.contains { $0.value != 0 }
            || gauges.all.contains { $0.dirty }
            || histograms.all.contains { $0.count > 0 }
            || distincts.all.contains { $0.dirty }
    }

    private func series<T>(
        _ map: inout SeriesMap<T>,
        _ kind: Character,
        _ name: String,
        _ dims: Dims?,
        _ factory: (Dims?) -> T
    ) throws -> T? {
        if name.isEmpty { throw WardxError("metric name must be a non-empty string") }
        let checked = try Dimensions.validate(dims, maxKeys: maxDimensionKeys, maxValueLength: maxDimensionValueLength)
        let key = Dimensions.dimKey(dims)
        let rejectKey = "\(kind)\0\(name)\0\(key)"
        if rejected.contains(rejectKey) { return nil }
        guard case .ok(let resolved) = checked else {
            rejected.insert(rejectKey)
            onCardinalityDropped()
            return nil
        }
        if let existing = map.get(name, key) { return existing }
        if map.count(name) >= maxSeriesPerMetric {
            rejected.insert(rejectKey)
            onCardinalityDropped()
            return nil
        }
        let created = factory(resolved)
        map.insert(name, key, created)
        return created
    }
}

private struct SeriesMap<T> {
    private var byName: [String: [String: T]] = [:]
    private(set) var all: [T] = []

    func get(_ name: String, _ key: String) -> T? {
        byName[name]?[key]
    }

    func count(_ name: String) -> Int {
        byName[name]?.count ?? 0
    }

    mutating func insert(_ name: String, _ key: String, _ series: T) {
        byName[name, default: [:]][key] = series
        all.append(series)
    }
}

struct EventSample {
    let time: Int64
    let name: String
    let attrs: [String: JSONValue]?
}

struct LogSample {
    let time: Int64
    let level: LogLevel
    let message: String
    let attrs: [String: JSONValue]?
}

enum LogLevel: Int, Comparable {
    case debug = 0
    case info = 1
    case warn = 2
    case error = 3

    var wire: String {
        switch self {
        case .debug: return "debug"
        case .info: return "info"
        case .warn: return "warn"
        case .error: return "error"
        }
    }

    static func < (lhs: LogLevel, rhs: LogLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

struct EventBuffer {
    private let max: Int
    private var buffer: [EventSample] = []

    init(maxBufferedEvents: Int) {
        precondition(maxBufferedEvents >= 1, "maxBufferedEvents must be >= 1")
        max = maxBufferedEvents
    }

    var count: Int { buffer.count }

    mutating func push(_ name: String, _ attrs: [String: JSONValue]?) throws -> Bool {
        if name.isEmpty { throw WardxError("event name must be a non-empty string") }
        if buffer.count >= max { return false }
        buffer.append(EventSample(time: Clock.unixMs(), name: name, attrs: attrs))
        return true
    }

    mutating func swap() -> [EventSample] {
        defer { buffer = [] }
        return buffer
    }
}

/// When full, a log replaces the oldest buffered log of the lowest level below its own.
struct LogBuffer {
    private let max: Int
    private var buffer: [LogSample] = []

    init(maxBufferedLogs: Int) {
        precondition(maxBufferedLogs >= 1, "maxBufferedLogs must be >= 1")
        max = maxBufferedLogs
    }

    var count: Int { buffer.count }

    mutating func push(_ level: LogLevel, _ message: String, _ attrs: [String: JSONValue]?) throws -> Bool {
        if message.isEmpty { throw WardxError("log message must be a non-empty string") }
        let entry = LogSample(time: Clock.unixMs(), level: level, message: message, attrs: attrs)
        if buffer.count < max {
            buffer.append(entry)
            return true
        }
        var victim: Int?
        var victimLevel = level
        for (index, sample) in buffer.enumerated() where sample.level < victimLevel {
            victimLevel = sample.level
            victim = index
        }
        if let victim { buffer[victim] = entry }
        return false
    }

    mutating func swap() -> [LogSample] {
        defer { buffer = [] }
        return buffer
    }
}
