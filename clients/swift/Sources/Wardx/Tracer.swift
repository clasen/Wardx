import Foundation

/// Local diagnostics for measurements, buffered rows, frames, and syncs. Callbacks run on the
/// instrumentation path; nothing here goes over the wire.
public protocol WardxTracer: Sendable {
    func measure(_ record: MeasureRecord)
    func event(_ record: EventRecord)
    func log(_ record: LogRecord)
    func frame(_ record: FrameRecord)
    func sync(_ record: SyncRecord)
}

extension WardxTracer {
    public func measure(_ record: MeasureRecord) {}
    public func event(_ record: EventRecord) {}
    public func log(_ record: LogRecord) {}
    public func frame(_ record: FrameRecord) {}
    public func sync(_ record: SyncRecord) {}
}

public struct MeasureRecord: Sendable {
    public let type: String
    public let name: String
    public let dims: Dims?
    public let op: String
    public let value: Double
    public let attrs: Dims?
    public let noop: Bool
}

public struct EventRecord: Sendable {
    public let name: String
    public let attrs: Dims?
    public let dropped: Bool
}

public struct LogRecord: Sendable {
    public let level: String
    public let message: String
    public let attrs: Dims?
    public let dropped: Bool
}

public struct FrameRecord: Sendable {
    public let seq: Int
    public let from: Int64
    public let to: Int64
    public let counters: Int
    public let gauges: Int
    public let histograms: Int
    public let distincts: Int
    public let events: Int
    public let logs: Int
    public let droppedLogs: Int
    public let droppedEvents: Int
    public let droppedRows: Int
}

public struct SyncRecord: Sendable {
    public let phase: String
    public let frames: Int
    public let bytesUncompressed: Int
    public let bytesCompressed: Int
    public let ms: Double
    public let ok: Bool
    public let status: Int?
    public let configVersion: Int?
    public let appliedConfig: Bool
}

/// Writes one line per record to standard error, or to the supplied writer.
public struct ConsoleTracer: WardxTracer {
    private let write: @Sendable (String) -> Void

    public init(write: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data(($0 + "\n").utf8)) }) {
        self.write = write
    }

    public func measure(_ record: MeasureRecord) {
        let noop = record.noop ? " noop" : ""
        emit("measure", pad(record.type) + " " + record.name + format(record.dims) + "  " + record.op + " "
            + JSON.number(record.value) + format(record.attrs) + noop)
    }

    public func event(_ record: EventRecord) {
        emit("event", record.name + format(record.attrs) + (record.dropped ? " dropped" : ""))
    }

    public func log(_ record: LogRecord) {
        emit("log", record.level + " " + record.message + format(record.attrs) + (record.dropped ? " dropped" : ""))
    }

    public func frame(_ record: FrameRecord) {
        var extra = ""
        if record.droppedLogs != 0 { extra += "  droppedLogs=\(record.droppedLogs)" }
        if record.droppedEvents != 0 { extra += "  droppedEvents=\(record.droppedEvents)" }
        emit("frame", "seq=\(record.seq)  counters=\(record.counters) gauges=\(record.gauges) histograms=\(record.histograms) events=\(record.events) logs=\(record.logs)" + extra)
    }

    public func sync(_ record: SyncRecord) {
        let status = record.status.map { " status=\($0)" } ?? ""
        let config = record.configVersion.map { " config=\($0)" } ?? ""
        let applied = record.appliedConfig ? " +config" : ""
        emit("sync", "\(record.phase) frames=\(record.frames) gzip=\(record.bytesCompressed)B "
            + String(format: "%.1f", record.ms) + "ms " + (record.ok ? "ok" : "fail") + status + config + applied)
    }

    private func emit(_ kind: String, _ rest: String) {
        write("wardx  " + pad(kind) + " " + rest)
    }

    private func pad(_ text: String) -> String {
        text.count >= 10 ? text : text + String(repeating: " ", count: 10 - text.count)
    }

    private func format(_ dims: Dims?) -> String {
        guard let dims, !dims.isEmpty else { return "" }
        return " " + dims.keys.sorted().map { $0 + "=" + dims[$0]!.text }.joined(separator: ",")
    }
}

final class TracedCounter: Counter, @unchecked Sendable {
    private let inner: any Counter
    private let tracer: any WardxTracer
    private let name: String
    private let dims: Dims?
    private let noop: Bool

    init(_ inner: any Counter, _ tracer: any WardxTracer, _ name: String, _ dims: Dims?, noop: Bool) {
        self.inner = inner
        self.tracer = tracer
        self.name = name
        self.dims = dims
        self.noop = noop
    }

    func inc() {
        inner.inc()
        tracer.measure(MeasureRecord(type: "counter", name: name, dims: dims, op: "inc", value: 1, attrs: nil, noop: noop))
    }

    func add(_ n: Double) {
        inner.add(n)
        tracer.measure(MeasureRecord(type: "counter", name: name, dims: dims, op: "add", value: n, attrs: nil, noop: noop))
    }
}

final class TracedGauge: Gauge, @unchecked Sendable {
    private let inner: any Gauge
    private let tracer: any WardxTracer
    private let name: String
    private let dims: Dims?
    private let noop: Bool

    init(_ inner: any Gauge, _ tracer: any WardxTracer, _ name: String, _ dims: Dims?, noop: Bool) {
        self.inner = inner
        self.tracer = tracer
        self.name = name
        self.dims = dims
        self.noop = noop
    }

    func set(_ value: Double) {
        inner.set(value)
        tracer.measure(MeasureRecord(type: "gauge", name: name, dims: dims, op: "set", value: value, attrs: nil, noop: noop))
    }
}

final class TracedHistogram: Histogram, @unchecked Sendable {
    private let inner: any Histogram
    private let tracer: any WardxTracer
    private let name: String
    private let dims: Dims?
    private let noop: Bool

    init(_ inner: any Histogram, _ tracer: any WardxTracer, _ name: String, _ dims: Dims?, noop: Bool) {
        self.inner = inner
        self.tracer = tracer
        self.name = name
        self.dims = dims
        self.noop = noop
    }

    func observe(_ value: Double, attrs: Dims?) {
        inner.observe(value, attrs: attrs)
        tracer.measure(MeasureRecord(type: "histogram", name: name, dims: dims, op: "observe", value: value, attrs: attrs, noop: noop))
    }
}

final class TracedDistinct: Distinct, @unchecked Sendable {
    private let inner: any Distinct
    private let tracer: any WardxTracer
    private let name: String
    private let dims: Dims?
    private let noop: Bool

    init(_ inner: any Distinct, _ tracer: any WardxTracer, _ name: String, _ dims: Dims?, noop: Bool) {
        self.inner = inner
        self.tracer = tracer
        self.name = name
        self.dims = dims
        self.noop = noop
    }

    func add(_ identifier: String) {
        inner.add(identifier)
        tracer.measure(MeasureRecord(type: "distinct", name: name, dims: dims, op: "add", value: 1, attrs: nil, noop: noop))
    }
}
