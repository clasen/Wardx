struct InternalMetrics {
    var eventsDropped = 0.0
    var logsDropped = 0.0
    var cardinalityDropped = 0.0
    var framesSent = 0.0
    var framesFailed = 0.0
    var bytesUncompressed = 0.0
    var bytesCompressed = 0.0
    var eventsBuffered = 0.0
    var logsBuffered = 0.0
    var lastSyncMs = 0.0
    var configVersion = 0.0
    var processRssBytes = 0.0

    var hasCounterActivity: Bool {
        eventsDropped != 0 || logsDropped != 0 || cardinalityDropped != 0 || framesSent != 0
            || framesFailed != 0 || bytesUncompressed != 0 || bytesCompressed != 0
    }

    /// Returns the current values and resets the window counters; gauges keep their last value.
    mutating func snapshotAndReset() -> InternalMetrics {
        let snapshot = self
        eventsDropped = 0
        logsDropped = 0
        cardinalityDropped = 0
        framesSent = 0
        framesFailed = 0
        bytesUncompressed = 0
        bytesCompressed = 0
        return snapshot
    }
}

struct Frame {
    var seq: Int
    var from: Int64
    var to: Int64
    var counters: [CounterSample] = []
    var gauges: [GaugeSample] = []
    var histograms: [HistogramSample] = []
    var distincts: [DistinctSample] = []
    var events: [EventSample] = []
    var logs: [LogSample] = []
    var wireBytes = 0

    var rowCount: Int {
        counters.count + gauges.count + histograms.count + distincts.count + events.count + logs.count
    }

    func wire() -> JSONValue {
        var metrics: [String: JSONValue] = [
            "counters": .array(counters.map(Self.wire)),
            "gauges": .array(gauges.map(Self.wire)),
            "histograms": .array(histograms.map(Self.wire))
        ]
        if !distincts.isEmpty { metrics["distincts"] = .array(distincts.map(Self.wire)) }
        return .object([
            "seq": .number(Double(seq)),
            "from": .number(Double(from)),
            "to": .number(Double(to)),
            "metrics": .object(metrics),
            "events": .array(events.map(Self.wire)),
            "logs": .array(logs.map(Self.wire))
        ])
    }

    static func wire(_ row: CounterSample) -> JSONValue {
        .array([.string(row.name), jsonOrNull(jsonObject(row.dims)), .number(row.value)])
    }

    static func wire(_ row: GaugeSample) -> JSONValue {
        .array([.string(row.name), jsonOrNull(jsonObject(row.dims)), .number(row.value), .number(Double(row.timestamp))])
    }

    static func wire(_ row: HistogramSample) -> JSONValue {
        var body: [String: JSONValue] = [
            "count": .number(Double(row.body.count)),
            "sum": .number(row.body.sum),
            "min": .number(row.body.min),
            "max": .number(row.body.max),
            "buckets": .array(row.body.buckets.map { .array([.number($0.bound), .number(Double($0.count))]) })
        ]
        if let exemplar = row.body.exemplar {
            body["exemplar"] = .object(["value": .number(exemplar.value), "attrs": jsonOrNull(jsonObject(exemplar.attrs))])
        }
        return .array([.string(row.name), jsonOrNull(jsonObject(row.dims)), .object(body)])
    }

    static func wire(_ row: DistinctSample) -> JSONValue {
        .array([
            .string(row.name),
            jsonOrNull(jsonObject(row.dims)),
            .object(["precision": .number(Double(row.body.precision)), "registers": .string(row.body.registers)])
        ])
    }

    static func wire(_ row: EventSample) -> JSONValue {
        .array([.number(Double(row.time)), .string(row.name), jsonOrNull(row.attrs)])
    }

    static func wire(_ row: LogSample) -> JSONValue {
        .array([.number(Double(row.time)), .string(row.level.wire), .string(row.message), jsonOrNull(row.attrs)])
    }
}

struct FrameBatch {
    var frames: [Frame] = []
    var droppedCounters = 0
    var droppedGauges = 0
    var droppedHistograms = 0
    var droppedDistincts = 0
    var droppedEvents = 0
    var droppedLogs = 0

    var droppedRows: Int {
        droppedCounters + droppedGauges + droppedHistograms + droppedDistincts + droppedEvents + droppedLogs
    }
}

enum FrameBuilder {
    static func build(
        seq: Int,
        from: Int64,
        to: Int64,
        metrics: MetricSnapshot,
        events: [EventSample],
        logs: [LogSample],
        internals: InternalMetrics,
        now: Int64 = Clock.unixMs()
    ) -> Frame {
        var frame = Frame(
            seq: seq,
            from: from,
            to: to,
            counters: metrics.counters,
            gauges: metrics.gauges,
            histograms: metrics.histograms,
            distincts: metrics.distincts,
            events: events,
            logs: logs
        )
        mergeInternal(&frame, internals, now: now)
        return frame
    }

    static func shiftTime(_ frame: inout Frame, by offset: Int64) {
        guard offset != 0 else { return }
        frame.from += offset
        frame.to += offset
        frame.gauges = frame.gauges.map {
            GaugeSample(name: $0.name, dims: $0.dims, value: $0.value, timestamp: $0.timestamp + offset)
        }
        frame.events = frame.events.map { EventSample(time: $0.time + offset, name: $0.name, attrs: $0.attrs) }
        frame.logs = frame.logs.map {
            LogSample(time: $0.time + offset, level: $0.level, message: $0.message, attrs: $0.attrs)
        }
    }

    static func mergeInternal(_ frame: inout Frame, _ metrics: InternalMetrics, now: Int64) {
        let counters: [(String, Double)] = [
            (WireProtocol.Internal.eventsDropped, metrics.eventsDropped),
            (WireProtocol.Internal.logsDropped, metrics.logsDropped),
            (WireProtocol.Internal.cardinalityDropped, metrics.cardinalityDropped),
            (WireProtocol.Internal.framesSent, metrics.framesSent),
            (WireProtocol.Internal.framesFailed, metrics.framesFailed),
            (WireProtocol.Internal.bytesUncompressed, metrics.bytesUncompressed),
            (WireProtocol.Internal.bytesCompressed, metrics.bytesCompressed)
        ]
        for (name, value) in counters where value != 0 {
            frame.counters.append(CounterSample(name: name, dims: nil, value: value))
        }
        frame.gauges.append(GaugeSample(name: WireProtocol.Internal.eventsBuffered, dims: nil, value: metrics.eventsBuffered, timestamp: now))
        frame.gauges.append(GaugeSample(name: WireProtocol.Internal.logsBuffered, dims: nil, value: metrics.logsBuffered, timestamp: now))
        if metrics.lastSyncMs != 0 {
            frame.gauges.append(GaugeSample(name: WireProtocol.Internal.lastSyncMs, dims: nil, value: metrics.lastSyncMs, timestamp: now))
        }
        frame.gauges.append(GaugeSample(name: WireProtocol.Internal.configVersion, dims: nil, value: metrics.configVersion, timestamp: now))
        if metrics.processRssBytes != 0 {
            frame.gauges.append(GaugeSample(name: WireProtocol.Internal.processRssBytes, dims: nil, value: metrics.processRssBytes, timestamp: now))
        }
    }

    /// Splits one logical frame into physical frames within `maxFrameBytes` and `maxFrameRows`,
    /// with consecutive sequence numbers. A row that cannot fit even alone is dropped and counted.
    static func split(_ frame: Frame, maxFrameBytes: Int, maxFrameRows: Int) throws -> FrameBatch {
        if maxFrameBytes < 1024 { throw WardxError("maxFrameBytes must be an integer at least 1024") }
        if maxFrameRows < 1 { throw WardxError("maxFrameRows must be an integer at least 1") }
        var splitter = FrameSplitter(source: frame, maxFrameBytes: maxFrameBytes, maxFrameRows: maxFrameRows)
        for row in frame.counters where !splitter.add(row, \.counters, Frame.wire(row)) { splitter.batch.droppedCounters += 1 }
        for row in frame.gauges where !splitter.add(row, \.gauges, Frame.wire(row)) { splitter.batch.droppedGauges += 1 }
        for row in frame.histograms where !splitter.add(row, \.histograms, Frame.wire(row)) { splitter.batch.droppedHistograms += 1 }
        for row in frame.distincts where !splitter.add(row, \.distincts, Frame.wire(row), distinct: true) {
            splitter.batch.droppedDistincts += 1
        }
        for row in frame.events where !splitter.add(row, \.events, Frame.wire(row)) { splitter.batch.droppedEvents += 1 }
        for row in frame.logs where !splitter.add(row, \.logs, Frame.wire(row)) { splitter.batch.droppedLogs += 1 }
        return try splitter.finish()
    }
}

private struct FrameSplitter {
    // The first distinct row also introduces the optional JSON property.
    static let distinctsPropertyBytes = ",\"distincts\":[]".utf8.count

    let startingSeq: Int
    let from: Int64
    let to: Int64
    let maxFrameBytes: Int
    let maxFrameRows: Int
    var batch = FrameBatch()
    var current: Frame
    var currentBytes: Int

    init(source: Frame, maxFrameBytes: Int, maxFrameRows: Int) {
        startingSeq = source.seq
        from = source.from
        to = source.to
        self.maxFrameBytes = maxFrameBytes
        self.maxFrameRows = maxFrameRows
        current = Frame(seq: source.seq, from: source.from, to: source.to)
        currentBytes = JSON.byteCount(current.wire())
    }

    mutating func add<T>(_ row: T, _ rows: WritableKeyPath<Frame, [T]>, _ wire: JSONValue, distinct: Bool = false) -> Bool {
        let rowBytes = JSON.byteCount(wire)
        if append(row, rows, rowBytes, distinct) { return true }
        guard current.rowCount > 0 else { return false }
        finishCurrent()
        return append(row, rows, rowBytes, distinct)
    }

    private mutating func append<T>(_ row: T, _ rows: WritableKeyPath<Frame, [T]>, _ rowBytes: Int, _ distinct: Bool) -> Bool {
        let existing = current[keyPath: rows].count
        let added = rowBytes + (existing > 0 ? 1 : 0) + (distinct && existing == 0 ? Self.distinctsPropertyBytes : 0)
        if currentBytes + added > maxFrameBytes || current.rowCount >= maxFrameRows { return false }
        current[keyPath: rows].append(row)
        currentBytes += added
        return true
    }

    mutating func finish() throws -> FrameBatch {
        let dropped = batch.droppedRows
        if dropped > 0 {
            let observable = CounterSample(name: WireProtocol.Internal.frameRowsDropped, dims: nil, value: Double(dropped))
            if !add(observable, \.counters, Frame.wire(observable)) {
                throw WardxError("maxFrameBytes cannot contain the frame drop metric")
            }
        }
        if batch.frames.isEmpty || current.rowCount > 0 { finishCurrent() }
        for frame in batch.frames where frame.wireBytes > maxFrameBytes {
            throw WardxError("frame splitter produced an oversized frame")
        }
        return batch
    }

    private mutating func finishCurrent() {
        current.wireBytes = JSON.byteCount(current.wire())
        batch.frames.append(current)
        current = Frame(seq: startingSeq + batch.frames.count, from: from, to: to)
        currentBytes = JSON.byteCount(current.wire())
    }
}
