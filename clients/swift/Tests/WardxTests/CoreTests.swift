import Foundation
import Testing
@testable import Wardx

struct SettingsTests {
    @Test func requiresIdentityKeys() {
        #expect(throws: WardxError("createWardx missing required keys: endpoint, projectKey, project, role, appVersion, environment, privacySalt")) {
            try Settings.resolve(WardxOptions())
        }
        #expect(throws: WardxError("role cannot be *")) { try testSettings { $0.role = "*" } }
        #expect(throws: WardxError("maxFrameBytes must be at least 1024")) { try testSettings { $0.maxFrameBytes = 512 } }
        #expect(throws: WardxError("maxFrameBytes must be less than maxEnvelopeBytes")) {
            try testSettings { $0.maxEnvelopeBytes = SdkDefaults.maxFrameBytes }
        }
        #expect(throws: WardxError("syncJitterMax must be a finite number in [1, 2]")) { try testSettings { $0.syncJitterMax = 3 } }
        #expect(throws: WardxError("attributes values must be finite numbers")) {
            try WardxClient.create(testOptions { $0.attributes = ["tier": .number(.infinity)] }, transport: MemoryTransport())
        }
    }

    @Test func disabledNeedsNoKeys() throws {
        #expect(try Settings.resolve(WardxOptions(enabled: false)).enabled == false)
    }

    @Test func defaultsMatchTheCentralDefaults() throws {
        let url = repositoryRoot.appendingPathComponent("packages/core/defaults.json")
        let central = try JSON.parse(Data(contentsOf: url)).objectValue!
        let swift: [String: JSONValue] = [
            "aggregateIntervalMs": .number(Double(SdkDefaults.aggregateIntervalMs)),
            "syncIntervalMs": .number(Double(SdkDefaults.syncIntervalMs)),
            "syncJitterMin": .number(SdkDefaults.syncJitterMin),
            "syncJitterMax": .number(SdkDefaults.syncJitterMax),
            "maxBufferedEvents": .number(Double(SdkDefaults.maxBufferedEvents)),
            "maxBufferedLogs": .number(Double(SdkDefaults.maxBufferedLogs)),
            "maxFrameBytes": .number(Double(SdkDefaults.maxFrameBytes)),
            "maxPendingFrames": .number(Double(SdkDefaults.maxPendingFrames)),
            "maxEnvelopeItems": .number(Double(SdkDefaults.maxEnvelopeItems)),
            "maxEnvelopeBytes": .number(Double(SdkDefaults.maxEnvelopeBytes)),
            "maxSeriesPerMetric": .number(Double(SdkDefaults.maxSeriesPerMetric)),
            "maxDimensionKeys": .number(Double(SdkDefaults.maxDimensionKeys)),
            "maxDimensionValueLength": .number(Double(SdkDefaults.maxDimensionValueLength)),
            "experimentStateMaxSubjects": .number(Double(SdkDefaults.experimentStateMaxSubjects)),
            "httpTimeoutMs": .number(Double(SdkDefaults.httpTimeoutMs)),
            "histogramBuckets": .array(SdkDefaults.histogramBuckets.map(JSONValue.number))
        ]
        #expect(swift == central)
    }

    @Test func syncUrlAppendsThePathOnlyForBareEndpoints() throws {
        #expect(try URLSessionTransport.syncURL("http://127.0.0.1:8787").absoluteString == "http://127.0.0.1:8787/v1/sync")
        #expect(try URLSessionTransport.syncURL("http://127.0.0.1:8787/").absoluteString == "http://127.0.0.1:8787/v1/sync")
        #expect(try URLSessionTransport.syncURL("https://example.test/custom").absoluteString == "https://example.test/custom")
        #expect(throws: WardxError("endpoint must be an absolute URL")) { try URLSessionTransport.syncURL("not a url") }
    }
}

struct MetricsTests {
    @Test func seriesAccumulateAndReset() throws {
        let core = WardxCore(settings: try testSettings())
        let counter = try core.counter("requests", ["route": "/a"])
        counter.inc()
        counter.add(2)
        try core.gauge("players", nil).set(12)
        let histogram = try core.histogram("latency", nil, [10, 100])
        histogram.observe(5)
        histogram.observe(50, attrs: ["trace": "abc"])
        histogram.observe(500)
        let snapshot = try core.snapshotFrame().frames[0]
        let requests = snapshot.counters.first { $0.name == "requests" }
        #expect(requests?.value == 3)
        #expect(snapshot.gauges.contains { $0.name == "players" && $0.value == 12 })
        let latency = try #require(snapshot.histograms.first)
        #expect(latency.body.count == 3)
        #expect(latency.body.buckets.map(\.count) == [1, 1])
        #expect(latency.body.max == 500)
        #expect(latency.body.exemplar == nil)
        let next = try core.snapshotFrame().frames[0]
        #expect(!next.counters.contains { $0.name == "requests" })
        #expect(next.histograms.isEmpty)
    }

    @Test func exemplarKeepsAttrsOfTheWindowMax() throws {
        let core = WardxCore(settings: try testSettings())
        let histogram = try core.histogram("latency", nil, nil)
        histogram.observe(5, attrs: ["trace": "low"])
        histogram.observe(50, attrs: ["trace": "high"])
        let body = try core.snapshotFrame().frames[0].histograms[0].body
        #expect(body.exemplar?.value == 50)
        #expect(body.exemplar?.attrs == ["trace": "high"])
    }

    @Test func cardinalityIsBoundedPerMetric() throws {
        let core = WardxCore(settings: try testSettings { $0.maxSeriesPerMetric = 2 })
        for index in 0..<3 { try core.counter("hits", ["i": WardxValue(index)]).inc() }
        try core.counter("hits", ["k1": 1, "k2": 2, "k3": 3, "k4": 4, "k5": 5, "k6": 6, "k7": 7, "k8": 8, "k9": 9]).inc()
        try core.counter("hits", ["long": WardxValue(String(repeating: "x", count: 65))]).inc()
        let frame = try core.snapshotFrame().frames[0]
        #expect(frame.counters.filter { $0.name == "hits" }.count == 2)
        #expect(frame.counters.first { $0.name == WireProtocol.Internal.cardinalityDropped }?.value == 3)
    }

    @Test func misuseIsAnError() throws {
        let core = WardxCore(settings: try testSettings())
        #expect(throws: WardxError("metric name must be a non-empty string")) { try core.counter("", nil) }
        #expect(throws: WardxError("dimension x must be string, number, or boolean")) { try core.counter("c", ["x": .number(.nan)]) }
        _ = try core.histogram("h", nil, [1, 2])
        #expect(throws: WardxError("histogram h buckets cannot change for an existing series")) { try core.histogram("h", nil, [1, 3]) }
        #expect(throws: WardxError("histogram buckets must be strictly increasing finite numbers")) { try core.histogram("x", nil, [2, 1]) }
        #expect(throws: WardxError("event name must be a non-empty string")) { try core.event("", nil) }
        #expect(throws: WardxError("retentionActivity requires a non-empty userId")) { try core.retentionActivity(userId: " ", channel: nil) }
        #expect(throws: WardxError("conversion goal must match ^[a-z0-9][a-z0-9._-]{0,63}$")) { try core.conversion(userId: "u", goal: "Purchase") }
        #expect(throws: WardxError("retained metrics require retainedPath")) { try core.retainedCounter("r", nil) }
    }

    @Test func retentionLabels() {
        #expect(WardxCore.isRetentionLabel("tiktok"))
        #expect(WardxCore.isRetentionLabel("a.b_c-9"))
        #expect(!WardxCore.isRetentionLabel(".tiktok"))
        #expect(!WardxCore.isRetentionLabel("TikTok"))
        #expect(!WardxCore.isRetentionLabel(String(repeating: "a", count: 65)))
    }

    @Test func retentionEventsCarryOnlyHashes() throws {
        let core = WardxCore(settings: try testSettings())
        try core.retentionActivity(userId: "user-1", channel: "tiktok")
        try core.conversion(userId: "user-1", goal: "purchase")
        let rows = events(try core.snapshotFrame())
        let activity = try #require(rows.first { $0.name == "retention.activity" }?.attrs)
        let conversion = try #require(rows.first { $0.name == "retention.conversion" }?.attrs)
        #expect(activity["subject"] == .string(Hash.subjectHash(salt: "test-salt", subjectId: "user-1")))
        #expect(activity["channel"] == .string("tiktok"))
        #expect(conversion == ["subject": activity["subject"]!, "salt": activity["salt"]!, "goal": .string("purchase")])
    }

    @Test func distinctSendsOnlyTheSketch() throws {
        let core = WardxCore(settings: try testSettings())
        try core.distinct("hids", nil).add("private-hid")
        let wire = JSON.stringify(try core.snapshotFrame().frames[0].wire())
        #expect(!wire.contains("private-hid"))
        #expect(wire.contains("\"precision\":9"))
    }

    @Test func logBufferEvictsTheLowestLevelWhenFull() throws {
        var buffer = LogBuffer(maxBufferedLogs: 2)
        #expect(try buffer.push(.info, "a", nil))
        #expect(try buffer.push(.debug, "b", nil))
        #expect(try !buffer.push(.error, "c", nil))
        #expect(try !buffer.push(.debug, "d", nil))
        #expect(buffer.swap().map(\.message) == ["a", "c"])
    }
}

struct ExperimentTests {
    @Test func assignmentIsDeterministicAndHonorsAllocation() throws {
        let experiment = messageDelay()
        #expect(try Experiments.assignVariant(experiment, subjectId: "user-1")?.key == Experiments.assignVariant(experiment, subjectId: "user-1")?.key)
        var partial = experiment
        partial.allocation = 0.2
        let allocated = try (0..<5000).filter { try Experiments.assignVariant(partial, subjectId: "s-\($0)") != nil }.count
        let ratio = Double(allocated) / 5000
        #expect(ratio > 0.15 && ratio < 0.25)
    }

    @Test func configResolvesVariantsAndExposesOnce() throws {
        let core = WardxCore(settings: try testSettings())
        #expect(try core.configGet("message.delayMs", subjectId: nil) == nil)
        try core.applyConfig(version: 13, values: ["message.delayMs": .number(1000)], experiments: [messageDelay()])
        #expect(try core.configGet("message.delayMs", subjectId: nil) == .number(1000))
        let variant = try core.configGet("message.delayMs", subjectId: "user-1")
        #expect(variant == .number(1000) || variant == .number(400))
        _ = try core.configGet("message.delayMs", subjectId: "user-1")
        let exposures = events(try core.snapshotFrame()).filter { $0.name == "experiment.exposure" }
        #expect(exposures.count == 1)
        #expect(exposures[0].attrs?["subject"] == .string(Hash.subjectHash(salt: "test-salt", subjectId: "user-1")))

        try core.experimentGoal("message.sent", subjectId: "user-1", value: 1)
        let goals = events(try core.snapshotFrame()).filter { $0.name == "experiment.goal" }
        #expect(goals.count == 1)
        #expect(goals[0].attrs?["metric"] == .string("message.sent"))
        #expect(goals[0].attrs?["value"] == .number(1))
        #expect(goals[0].attrs?["experiments"]?.arrayValue?.count == 1)
    }

    @Test func identifySuppliesTheDefaultSubject() throws {
        let core = WardxCore(settings: try testSettings())
        try core.applyConfig(version: 1, values: ["message.delayMs": .number(1000)], experiments: [messageDelay()])
        try core.identify("user-1")
        #expect(try core.configGet("message.delayMs", subjectId: nil) == core.configGet("message.delayMs", subjectId: "user-1"))
        try core.identify(nil)
        #expect(try core.configGet("message.delayMs", subjectId: nil) == .number(1000))
        #expect(throws: WardxError("experiment.goal requires subjectId")) { try core.experimentGoal("message.sent", subjectId: nil, value: nil) }
        #expect(throws: WardxError("identify requires a non-empty subjectId")) { try core.identify("") }
    }

    @Test func goalBeforeExposureIsIgnored() throws {
        let core = WardxCore(settings: try testSettings())
        try core.applyConfig(version: 1, values: ["message.delayMs": .number(1000)], experiments: [messageDelay()])
        try core.experimentGoal("message.sent", subjectId: "user-1", value: nil)
        #expect(!events(try core.snapshotFrame()).contains { $0.name == "experiment.goal" })
    }

    @Test func stateIsBoundedAndClearedBySnapshots() throws {
        let core = WardxCore(settings: try testSettings { $0.experimentStateMaxSubjects = 2 })
        try core.applyConfig(version: 1, values: ["message.delayMs": .number(1000)], experiments: [messageDelay()])
        for subject in ["user-1", "user-2", "user-3", "user-1"] { _ = try core.configGet("message.delayMs", subjectId: subject) }
        #expect(core.experiments.stateCount == 2)
        #expect(events(try core.snapshotFrame()).filter { $0.name == "experiment.exposure" }.count == 4)

        var changed = messageDelay()
        changed.salt = "other"
        try core.applyConfig(version: 2, values: ["message.delayMs": .number(1000)], experiments: [changed])
        #expect(core.experiments.stateCount == 0)
    }

    @Test func experimentsRequireAGoalMetric() throws {
        var experiment = messageDelay()
        experiment.goalMetric = nil
        let core = WardxCore(settings: try testSettings())
        #expect(throws: WardxError("experiment message-delay-v1 requires a non-empty goalMetric")) {
            try core.applyConfig(version: 1, values: [:], experiments: [experiment])
        }
    }
}

struct FrameTests {
    @Test func splitKeepsFramesBoundedAndConsecutive() throws {
        let core = WardxCore(settings: try testSettings { $0.maxFrameBytes = 2048 })
        for index in 0..<300 { try core.event("sized", ["i": WardxValue(index), "text": WardxValue(String(repeating: "x", count: 100))]) }
        let batch = try core.snapshotFrame()
        #expect(batch.frames.count > 1)
        for (index, frame) in batch.frames.enumerated() {
            #expect(frame.seq == batch.frames[0].seq + index)
            #expect(frame.wireBytes == JSON.byteCount(frame.wire()))
            #expect(frame.wireBytes <= 2048)
        }
        #expect(batch.frames.flatMap(\.events).map { $0.attrs?["i"] } == (0..<300).map { .number(Double($0)) })
    }

    @Test func oversizedRowsAreDroppedAndCounted() throws {
        let frame = Frame(seq: 1, from: 0, to: 1, events: [
            EventSample(time: 1, name: "huge", attrs: ["text": .string(String(repeating: "x", count: 4000))]),
            EventSample(time: 1, name: "small", attrs: nil)
        ])
        let batch = try FrameBuilder.split(frame, maxFrameBytes: 1024, maxFrameRows: 100)
        #expect(batch.droppedEvents == 1)
        #expect(batch.frames.flatMap(\.events).map(\.name) == ["small"])
        #expect(batch.frames.flatMap(\.counters).contains { $0.name == WireProtocol.Internal.frameRowsDropped && $0.value == 1 })
    }

    @Test func distinctPropertyIsCountedInFrameSize() throws {
        let core = WardxCore(settings: try testSettings { $0.maxFrameBytes = 1024 })
        for index in 0..<20 { try core.distinct("hids", ["i": WardxValue(index)]).add("x") }
        let batch = try core.snapshotFrame()
        #expect(batch.frames.allSatisfy { $0.wireBytes <= 1024 })
        #expect(batch.frames.flatMap(\.distincts).count == 20)
    }

    @Test func rowLimitSplitsFrames() throws {
        let frame = Frame(seq: 5, from: 0, to: 1, events: (0..<10).map { EventSample(time: 1, name: "e\($0)", attrs: nil) })
        let batch = try FrameBuilder.split(frame, maxFrameBytes: 4096, maxFrameRows: 3)
        #expect(batch.frames.map(\.rowCount) == [3, 3, 3, 1])
        #expect(batch.frames.map(\.seq) == [5, 6, 7, 8])
    }

    @Test func shiftMovesEveryTimestamp() {
        var frame = Frame(
            seq: 1,
            from: 100,
            to: 200,
            gauges: [GaugeSample(name: "g", dims: nil, value: 1, timestamp: 150)],
            events: [EventSample(time: 160, name: "e", attrs: nil)],
            logs: [LogSample(time: 170, level: .info, message: "m", attrs: nil)]
        )
        FrameBuilder.shiftTime(&frame, by: -50)
        #expect([frame.from, frame.to, frame.gauges[0].timestamp, frame.events[0].time, frame.logs[0].time] == [50, 150, 100, 110, 120])
    }

    @Test func suspendedWindowEndsAtThePause() throws {
        let core = WardxCore(settings: try testSettings())
        try core.counter("before", nil).inc()
        core.suspend()
        let paused = Clock.unixMs()
        Thread.sleep(forTimeInterval: 0.02)
        core.resume()
        let resumed = Clock.unixMs()
        let cut = try core.snapshotFrame().frames[0]
        #expect(cut.to <= paused)
        try core.counter("after", nil).inc()
        let next = try core.snapshotFrame().frames[0]
        #expect(next.from >= resumed - 1)
    }
}
