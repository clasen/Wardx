import Foundation

public protocol Counter: Sendable {
    func inc()
    func add(_ n: Double)
}

public protocol Gauge: Sendable {
    func set(_ value: Double)
}

public protocol Histogram: Sendable {
    func observe(_ value: Double, attrs: Dims?)
}

extension Histogram {
    public func observe(_ value: Double) {
        observe(value, attrs: nil)
    }
}

public protocol Distinct: Sendable {
    func add(_ identifier: String)
}

/// Series state is not synchronized: the client guards it with its lock.
final class CounterSeries: Counter, @unchecked Sendable {
    let name: String
    let dims: Dims?
    var value = 0.0

    init(name: String, dims: Dims?) {
        self.name = name
        self.dims = dims
    }

    func inc() {
        value += 1
    }

    func add(_ n: Double) {
        guard n.isFinite else { return reportMisuse("counter.add requires a finite number") }
        value += n
    }
}

final class GaugeSeries: Gauge, @unchecked Sendable {
    let name: String
    let dims: Dims?
    var value = 0.0
    var timestamp: Int64 = 0
    var dirty = false

    init(name: String, dims: Dims?) {
        self.name = name
        self.dims = dims
    }

    func set(_ value: Double) {
        guard value.isFinite else { return reportMisuse("gauge.set requires a finite number") }
        self.value = value
        timestamp = Clock.unixMs()
        dirty = true
    }
}

struct HistogramExemplar {
    let value: Double
    let attrs: Dims
}

struct HistogramBody {
    let count: Int
    let sum: Double
    let min: Double
    let max: Double
    let buckets: [(bound: Double, count: Int)]
    let exemplar: HistogramExemplar?
}

final class HistogramSeries: Histogram, @unchecked Sendable {
    let name: String
    let dims: Dims?
    let bounds: [Double]
    private let maxDimensionKeys: Int
    private let maxDimensionValueLength: Int
    private var counts: [Int]
    private(set) var count = 0
    private var sum = 0.0
    private var min = Double.infinity
    private var max = -Double.infinity
    private var exemplar: HistogramExemplar?

    init(name: String, dims: Dims?, bounds: [Double], maxDimensionKeys: Int, maxDimensionValueLength: Int) {
        self.name = name
        self.dims = dims
        self.bounds = bounds
        self.maxDimensionKeys = maxDimensionKeys
        self.maxDimensionValueLength = maxDimensionValueLength
        counts = Array(repeating: 0, count: bounds.count)
    }

    func observe(_ value: Double, attrs: Dims?) {
        guard value.isFinite else { return reportMisuse("histogram.observe requires a finite number") }
        let isMax = value >= max
        count += 1
        sum += value
        if value < min { min = value }
        if isMax {
            max = value
            exemplar = exemplarFrom(value, attrs)
        }
        if let index = bounds.firstIndex(where: { value <= $0 }) { counts[index] += 1 }
    }

    private func exemplarFrom(_ value: Double, _ attrs: Dims?) -> HistogramExemplar? {
        guard let attrs else { return nil }
        guard case .ok(let checked?) = (try? Dimensions.validate(attrs, maxKeys: maxDimensionKeys, maxValueLength: maxDimensionValueLength)) else {
            return nil
        }
        return HistogramExemplar(value: value, attrs: checked)
    }

    func snapshot() -> HistogramBody {
        HistogramBody(
            count: count,
            sum: sum,
            min: min,
            max: max,
            buckets: zip(bounds, counts).map { (bound: $0, count: $1) },
            exemplar: exemplar
        )
    }

    func reset() {
        counts = Array(repeating: 0, count: bounds.count)
        count = 0
        sum = 0
        min = .infinity
        max = -.infinity
        exemplar = nil
    }
}

struct HllBody: Equatable {
    let precision: Int
    let registers: String
}

final class HyperLogLog: Distinct, @unchecked Sendable {
    static let precision = 9
    static let registerCount = 1 << precision

    let name: String
    let dims: Dims?
    private let privacySalt: String
    private var registers = [UInt8](repeating: 0, count: registerCount)
    private(set) var dirty = false

    init(name: String, dims: Dims?, privacySalt: String) {
        precondition(!privacySalt.isEmpty, "distinct requires a non-empty privacySalt")
        self.name = name
        self.dims = dims
        self.privacySalt = privacySalt
    }

    func add(_ identifier: String) {
        guard !identifier.isEmpty else { return reportMisuse("distinct.add requires a non-empty string") }
        let digest = Hash.subjectHash64(salt: privacySalt, subjectId: identifier)
        let index = Int(digest >> UInt64(64 - Self.precision))
        let rank = Self.rankAfterIndex(digest)
        if rank > registers[index] { registers[index] = rank }
        dirty = true
    }

    func snapshot() -> HllBody {
        HllBody(precision: Self.precision, registers: Data(registers).base64EncodedString())
    }

    func merge(_ body: HllBody) throws {
        guard body.precision == Self.precision else {
            throw WardxError("distinct merge requires precision \(Self.precision)")
        }
        guard let data = Data(base64Encoded: body.registers), data.count == Self.registerCount else {
            throw WardxError("distinct merge requires \(Self.registerCount) registers")
        }
        for (index, register) in data.enumerated() where register > registers[index] {
            registers[index] = register
            dirty = true
        }
    }

    func reset() {
        registers = [UInt8](repeating: 0, count: Self.registerCount)
        dirty = false
    }

    private static func rankAfterIndex(_ digest: UInt64) -> UInt8 {
        var rank: UInt8 = 1
        for bit in precision..<64 {
            if digest & (UInt64(1) << UInt64(63 - bit)) != 0 { return rank }
            rank += 1
        }
        return rank
    }
}

struct NoopCounter: Counter {
    func inc() {}
    func add(_ n: Double) {}
}

struct NoopGauge: Gauge {
    func set(_ value: Double) {}
}

struct NoopHistogram: Histogram {
    func observe(_ value: Double, attrs: Dims?) {}
}

struct NoopDistinct: Distinct {
    func add(_ identifier: String) {}
}

/// Measures elapsed milliseconds from creation until the first `stop`.
public final class TimerToken: @unchecked Sendable {
    private let lock = NSLock()
    private let onStop: @Sendable (Dims?) -> Void
    private var stopped = false

    init(_ onStop: @escaping @Sendable (Dims?) -> Void) {
        self.onStop = onStop
    }

    public func stop(_ endDims: Dims? = nil) {
        let first = lock.withLock {
            defer { stopped = true }
            return !stopped
        }
        if first { onStop(endDims) }
    }
}

/// Programmer errors at measurement sites stop debug builds and drop the call in release builds,
/// so instrumentation never takes down the host app.
func reportMisuse(_ message: String) {
    Misuse.report(message)
}

enum Misuse {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: @Sendable (String) -> Void = { message in
        assertionFailure("wardx: " + message)
    }

    static func report(_ message: String) {
        let current = lock.withLock { handler }
        current(message)
    }

    /// Replaces the handler for tests that exercise misuse; returns the previous one.
    @discardableResult
    static func replaceHandler(_ next: @escaping @Sendable (String) -> Void) -> @Sendable (String) -> Void {
        lock.withLock {
            let previous = handler
            handler = next
            return previous
        }
    }
}
